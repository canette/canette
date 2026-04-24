import type { DB } from "../db/db"
import type { AdminAppSummary, AdminProjectOverview, AdminTeamOverview, DeploymentStatus, ResourceDefaults, ScanPolicy, SyncResult, User, UserRole, WebhookSettings } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db/types"
import { sql } from "kysely"
import { ServiceError } from "./errors"

// ── Users ─────────────────────────────────────────────────────────────────────

// Only select what we need — emailVerified and updatedAt are auth-internal columns.
type UserRow = Pick<Selectable<Database["user"]>, "id" | "name" | "email" | "image" | "role" | "createdAt">

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image ?? undefined,
    role: row.role as UserRole,
    createdAt: row.createdAt,
  }
}

export async function getCurrentUser(
  db: DB,
  userId: string
): Promise<(User & { hasPassword: boolean }) | null> {
  const [userRow, accountRow] = await Promise.all([
    db
      .selectFrom("user")
      .select(["id", "name", "email", "image", "role", "createdAt"])
      .where("id", "=", userId)
      .executeTakeFirst(),
    db
      .selectFrom("account")
      .select("id")
      .where("userId", "=", userId)
      .where("providerId", "=", "credential")
      .limit(1)
      .executeTakeFirst(),
  ])
  if (!userRow) return null
  return { ...mapUser(userRow), hasPassword: !!accountRow }
}

export async function updateCurrentUser(
  db: DB,
  userId: string,
  patch: { name: string }
): Promise<User> {
  await db
    .updateTable("user")
    .set({ name: patch.name, updatedAt: new Date().toISOString() })
    .where("id", "=", userId)
    .execute()
  const row = await db
    .selectFrom("user")
    .select(["id", "name", "email", "image", "role", "createdAt"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow()
  return mapUser(row)
}

export async function listUsers(db: DB): Promise<User[]> {
  const rows = await db
    .selectFrom("user")
    .select(["id", "name", "email", "image", "role", "createdAt"])
    .orderBy("createdAt", "asc")
    .execute()
  return rows.map(mapUser)
}

export async function updateUserRole(
  db: DB,
  id: string,
  role: UserRole,
  requesterId: string
): Promise<User> {
  if (id === requesterId) {
    throw new ServiceError("Cannot change your own role", "FORBIDDEN", 403)
  }
  if (role !== "admin" && role !== "developer") {
    throw new ServiceError("Invalid role", "INVALID_INPUT", 400)
  }
  await db
    .updateTable("user")
    .set({ role })
    .where("id", "=", id)
    .execute()
  const row = await db
    .selectFrom("user")
    .select(["id", "name", "email", "image", "role", "createdAt"])
    .where("id", "=", id)
    .executeTakeFirst()
  if (!row) throw new ServiceError("User not found", "NOT_FOUND", 404)
  return mapUser(row)
}

export async function deleteUser(
  db: DB,
  id: string,
  requesterId: string
): Promise<boolean> {
  if (id === requesterId) {
    throw new ServiceError("Cannot delete your own account", "FORBIDDEN", 403)
  }
  // Block deletion if the user owns any team — admin must delete the team first.
  const ownedTeam = await db
    .selectFrom("teams")
    .select("name")
    .where("owner_id", "=", id)
    .limit(1)
    .executeTakeFirst()
  if (ownedTeam) {
    throw new ServiceError(
      `Cannot delete this user: they own the team "${ownedTeam.name}". Delete or transfer ownership of the team first.`,
      "CONFLICT",
      409
    )
  }
  const result = await db
    .deleteFrom("user")
    .where("id", "=", id)
    .executeTakeFirst()
  return (result.numDeletedRows ?? 0n) > 0n
}

// ── Overview ──────────────────────────────────────────────────────────────────

interface AppOverviewRow {
  id: string
  project_id: string
  name: string
  slug: string
  source_type: string
  live_url: string | null
  latest_status: string | null
  latest_deployment_at: string | null
}

export async function getProjectsOverview(db: DB): Promise<AdminProjectOverview[]> {
  const projects = await db
    .selectFrom("projects as p")
    .innerJoin("teams as t", "t.id", "p.team_id")
    .select(["p.id", "p.name", "p.slug", "p.created_at", "t.name as team_name"])
    .orderBy("p.created_at", "asc")
    .execute()

  if (projects.length === 0) return []

  // The LEFT JOIN with correlated subquery for latest-per-app is intentionally kept
  // as a sql tag — forcing it through Kysely's builder would be no clearer.
  const appsResult = await sql<AppOverviewRow>`
    SELECT
      a.id, a.project_id, a.name, a.slug, a.source_type, a.live_url,
      d.status AS latest_status,
      d.created_at AS latest_deployment_at
    FROM apps a
    LEFT JOIN deployments d ON d.id = (
      SELECT id FROM deployments
      WHERE app_id = a.id
      ORDER BY created_at DESC LIMIT 1
    )
    ORDER BY a.created_at ASC
  `.execute(db)

  const appsByProject = new Map<string, AdminAppSummary[]>()
  for (const r of appsResult.rows) {
    const summary: AdminAppSummary = {
      id: r.id,
      name: r.name,
      slug: r.slug,
      sourceType: r.source_type as "git" | "image",
      liveUrl: r.live_url ?? undefined,
      latestDeploymentStatus: (r.latest_status as DeploymentStatus) ?? undefined,
      latestDeploymentAt: r.latest_deployment_at ?? undefined,
    }
    const list = appsByProject.get(r.project_id) ?? []
    list.push(summary)
    appsByProject.set(r.project_id, list)
  }

  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    teamName: (p as typeof p & { team_name: string }).team_name,
    createdAt: p.created_at,
    apps: appsByProject.get(p.id) ?? [],
  }))
}

// ── Scan policy ───────────────────────────────────────────────────────────────

export async function getScanPolicy(db: DB): Promise<ScanPolicy> {
  const rows = await db
    .selectFrom("admin_settings")
    .select(["key", "value"])
    .where("key", "like", "security.%")
    .execute()
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return {
    enabled: settings["security.scan_enabled"] === "true",
    mandatory: settings["security.scan_mandatory"] === "true",
    failSeverity: (settings["security.fail_severity"] ?? "CRITICAL") as ScanPolicy["failSeverity"],
  }
}

export async function updateScanPolicy(
  db: DB,
  patch: Partial<ScanPolicy>
): Promise<ScanPolicy> {
  const now = new Date().toISOString()
  if (patch.enabled !== undefined) {
    await db
      .insertInto("admin_settings")
      .values({ key: "security.scan_enabled", value: patch.enabled ? "true" : "false", updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: patch.enabled ? "true" : "false", updated_at: now }))
      .execute()
  }
  if (patch.mandatory !== undefined) {
    await db
      .insertInto("admin_settings")
      .values({ key: "security.scan_mandatory", value: patch.mandatory ? "true" : "false", updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: patch.mandatory ? "true" : "false", updated_at: now }))
      .execute()
  }
  if (patch.failSeverity !== undefined) {
    const valid = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    if (!valid.includes(patch.failSeverity)) {
      throw new ServiceError("Invalid failSeverity", "VALIDATION_ERROR", 400)
    }
    await db
      .insertInto("admin_settings")
      .values({ key: "security.fail_severity", value: patch.failSeverity, updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: patch.failSeverity!, updated_at: now }))
      .execute()
  }
  return getScanPolicy(db)
}

// ── Resource defaults ─────────────────────────────────────────────────────────

// Resource defaults are configured via Helm values and injected as environment variables.
// They are read-only at runtime — change them by updating the Helm release.
export function getResourceDefaults(): ResourceDefaults {
  return {
    cpuRequest: process.env.DEFAULT_CPU_REQUEST ?? "100m",
    memoryRequest: process.env.DEFAULT_MEMORY_REQUEST ?? "128Mi",
    cpuLimit: process.env.DEFAULT_CPU_LIMIT ?? "500m",
    memoryLimit: process.env.DEFAULT_MEMORY_LIMIT ?? "512Mi",
  }
}

// ── Webhook settings ──────────────────────────────────────────────────────────

// Webhook base URL is configured via Helm values and injected as WEBHOOK_BASE_URL.
// It is read-only at runtime — change it by updating the Helm release.
export function getWebhookSettings(): WebhookSettings {
  return { baseUrl: process.env.WEBHOOK_BASE_URL ?? "" }
}

// ── Reset stuck builds ────────────────────────────────────────────────────────

export async function resetStuckBuilds(db: DB): Promise<SyncResult> {
  const now = new Date().toISOString()
  const result = await db
    .updateTable("deployments")
    .set({
      status: "failed",
      error_message: "Reset by admin: deployment was stuck in an intermediate state",
      updated_at: now,
    })
    .where("status", "in", ["building", "scanning"])
    .executeTakeFirst()
  const synced = Number(result.numUpdatedRows ?? 0n)
  return {
    synced,
    message:
      synced === 0
        ? "No stuck builds found."
        : `${synced} deployment${synced === 1 ? "" : "s"} reset to failed.`,
  }
}

// ── Force sync ────────────────────────────────────────────────────────────────

export async function forceSyncLiveApps(db: DB): Promise<SyncResult> {
  const now = new Date().toISOString()
  // Reset the latest-live deployment for every app back to 'deploying'.
  // The controller picks it up on the next poll and re-applies K8s manifests.
  // Server-side apply is idempotent — if resources are already correct this is a no-op.
  // The self-referential subquery is kept as sql tag for clarity.
  const result = await sql<{ count: string }>`
    UPDATE deployments
    SET status = 'deploying', error_message = NULL, updated_at = ${now}
    WHERE status = 'live'
      AND id IN (
        SELECT id FROM deployments d2
        WHERE d2.app_id = deployments.app_id
        ORDER BY created_at DESC LIMIT 1
      )
  `.execute(db)
  const synced = result.numAffectedRows !== undefined ? Number(result.numAffectedRows) : 0
  return {
    synced,
    message:
      synced === 0
        ? "No live apps found — nothing to sync."
        : `${synced} app${synced === 1 ? "" : "s"} re-queued for reconciliation.`,
  }
}
