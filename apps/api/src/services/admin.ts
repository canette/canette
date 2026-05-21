import type { DB } from "../db/db"
import type { AdminAppSummary, AdminProjectOverview, DeploymentStatus, ResourceDefaults, ScanInfo, SyncResult, TeamMember, User, UserDeletionImpact, UserRole, WebhookSettings } from "@canette/types"
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

  const credentialAccounts = await db
    .selectFrom("account")
    .select("userId")
    .where("providerId", "=", "credential")
    .execute()
  const hasPasswordSet = new Set(credentialAccounts.map((a) => a.userId))

  return rows.map((row) => ({ ...mapUser(row), hasPassword: hasPasswordSet.has(row.id) }))
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

export async function getUserDeletionImpact(db: DB, userId: string): Promise<UserDeletionImpact> {
  const [personalTeam, sharedTeams] = await Promise.all([
    db.selectFrom("teams").select(["id"]).where("owner_id", "=", userId).where("is_personal", "=", true).executeTakeFirst(),
    db.selectFrom("teams").select("name").where("owner_id", "=", userId).where("is_personal", "=", false).execute(),
  ])

  let personalTeamImpact: UserDeletionImpact["personalTeam"] = null
  if (personalTeam) {
    const projects = await db
      .selectFrom("projects")
      .select("id")
      .where("team_id", "=", personalTeam.id)
      .execute()

    let appCount = 0
    const inFlightAppNames: string[] = []

    if (projects.length > 0) {
      const projectIds = projects.map((p) => p.id)
      const apps = await db
        .selectFrom("apps")
        .select(["id", "name"])
        .where("project_id", "in", projectIds)
        .execute()

      appCount = apps.length

      if (apps.length > 0) {
        const appIds = apps.map((a) => a.id)
        const deployments = await db
          .selectFrom("deployments")
          .select(["app_id", "status", "created_at"])
          .where("app_id", "in", appIds)
          .orderBy("created_at", "desc")
          .execute()

        const latestByApp = new Map<string, string>()
        for (const d of deployments) {
          if (!latestByApp.has(d.app_id)) latestByApp.set(d.app_id, d.status)
        }

        const inFlight = new Set(["building", "scanning", "pending_deployment", "deploying"])
        const appNameById = new Map(apps.map((a) => [a.id, a.name]))
        for (const [appId, status] of latestByApp) {
          if (inFlight.has(status)) inFlightAppNames.push(appNameById.get(appId) ?? appId)
        }
      }
    }

    personalTeamImpact = { projectCount: projects.length, appCount, inFlightAppNames }
  }

  return {
    personalTeam: personalTeamImpact,
    sharedTeamsReowned: sharedTeams.map((t) => t.name),
  }
}

export async function deleteUser(
  db: DB,
  id: string,
  requesterId: string,
  options: { force?: boolean } = {}
): Promise<boolean> {
  if (id === requesterId) {
    throw new ServiceError("Cannot delete your own account", "FORBIDDEN", 403)
  }

  // Reassign ownership of shared teams to the requesting admin — owner_id carries
  // no access-control meaning on non-personal teams, it's just metadata.
  await db
    .updateTable("teams")
    .set({ owner_id: requesterId, updated_at: new Date().toISOString() })
    .where("owner_id", "=", id)
    .where("is_personal", "=", false)
    .execute()

  const personalTeam = await db
    .selectFrom("teams")
    .select(["id"])
    .where("owner_id", "=", id)
    .where("is_personal", "=", true)
    .executeTakeFirst()

  if (personalTeam) {
    const projects = await db
      .selectFrom("projects")
      .select(["id", "slug"])
      .where("team_id", "=", personalTeam.id)
      .execute()

    if (projects.length > 0) {
      if (!options.force) {
        const n = projects.length
        throw new ServiceError(
          `User has ${n} project${n === 1 ? "" : "s"}. Use force deletion to remove everything.`,
          "CONFLICT",
          409
        )
      }

      const projectIds = projects.map((p) => p.id)
      const apps = await db
        .selectFrom("apps")
        .select(["id", "name"])
        .where("project_id", "in", projectIds)
        .execute()

      if (apps.length > 0) {
        const appIds = apps.map((a) => a.id)
        const deployments = await db
          .selectFrom("deployments")
          .select(["app_id", "status", "created_at"])
          .where("app_id", "in", appIds)
          .orderBy("created_at", "desc")
          .execute()

        const latestByApp = new Map<string, string>()
        for (const d of deployments) {
          if (!latestByApp.has(d.app_id)) latestByApp.set(d.app_id, d.status)
        }

        const inFlight = new Set(["building", "scanning", "pending_deployment", "deploying"])
        const blocked = apps.filter((a) => {
          const s = latestByApp.get(a.id)
          return s !== undefined && inFlight.has(s)
        })
        if (blocked.length > 0) {
          const names = blocked.map((a) => a.name).join(", ")
          throw new ServiceError(
            `Cannot delete: ${blocked.length} app${blocked.length === 1 ? " is" : "s are"} actively building or deploying (${names}). Stop them first.`,
            "CONFLICT",
            409
          )
        }

        const now = new Date().toISOString()

        // Stop live deployments so the controller can tear down K8s resources.
        await db
          .updateTable("deployments")
          .set({ status: "stopped", error_message: null, updated_at: now })
          .where("app_id", "in", appIds)
          .where("status", "=", "live")
          .execute()

        await db
          .updateTable("apps")
          .set({ live_url: null })
          .where("id", "in", appIds)
          .execute()
      }

      // Queue namespace deletions before removing project records.
      const now = new Date().toISOString()
      for (const project of projects) {
        await db
          .insertInto("queued_namespace_cleanups")
          .values({ id: crypto.randomUUID(), project_id: project.id, project_slug: project.slug, created_at: now })
          .onConflict((oc) => oc.doNothing())
          .execute()
      }

      // Delete projects; apps/deployments/etc cascade.
      await db.deleteFrom("projects").where("id", "in", projectIds).execute()
    }

    await db.deleteFrom("team_members").where("team_id", "=", personalTeam.id).execute()
    await db.deleteFrom("teams").where("id", "=", personalTeam.id).execute()
  }

  const result = await db.deleteFrom("user").where("id", "=", id).executeTakeFirst()
  return (result.numDeletedRows ?? 0n) > 0n
}

// ── Team member management (admin-scoped, no membership check) ────────────────

export async function getTeamMembersForAdmin(db: DB, teamId: string): Promise<TeamMember[] | null> {
  const team = await db.selectFrom("teams").select("id").where("id", "=", teamId).executeTakeFirst()
  if (!team) return null
  const rows = await db
    .selectFrom("team_members as tm")
    .innerJoin("user as u", "u.id", "tm.user_id")
    .select(["tm.user_id", "tm.created_at", "u.name", "u.email", "u.image"])
    .where("tm.team_id", "=", teamId)
    .orderBy("tm.created_at", "asc")
    .execute()
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    image: r.image ?? undefined,
    joinedAt: r.created_at,
  }))
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

// ── Security info ─────────────────────────────────────────────────────────────

// Scan configuration is set via Helm values and injected as environment variables.
// It is read-only at runtime — change it by updating the Helm release.
export function getSecurityInfo(): ScanInfo {
  const providerEnv = process.env.SCAN_PROVIDER ?? "auto"
  const enabledEnv = process.env.SCAN_ENABLED ?? ""
  const imageRepo = process.env.IMAGE_REPO ?? ""

  // Resolve provider name for display (mirrors scanner.detectProvider in Go)
  let provider = providerEnv
  if (provider === "auto" || provider === "") {
    provider = /\.ecr\.[a-z0-9-]+\.amazonaws\.com(\/|$)/.test(imageRepo) ? "ecr" : "trivy"
  }
  if (provider === "none") {
    return { provider: "none", enabled: false, mandatory: false, failSeverity: "HIGH" }
  }

  // Resolve enabled with same provider-aware defaults as the Go builder
  let enabled: boolean
  if (enabledEnv === "true") enabled = true
  else if (enabledEnv === "false") enabled = false
  else enabled = provider === "ecr"

  return {
    provider,
    enabled,
    mandatory: process.env.SCAN_MANDATORY === "true",
    failSeverity: (process.env.SCAN_FAIL_SEVERITY ?? "HIGH") as ScanInfo["failSeverity"],
  }
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

// ── Signup mode ───────────────────────────────────────────────────────────────

export async function getSignupMode(db: DB): Promise<string> {
  const row = await db
    .selectFrom("admin_settings")
    .select("value")
    .where("key", "=", "signup.mode")
    .executeTakeFirst()
  return row?.value ?? "open"
}

export async function setSignupMode(db: DB, mode: string): Promise<void> {
  if (mode !== "open" && mode !== "disabled" && mode.length < 8) {
    throw new ServiceError("Invite code must be at least 8 characters", "VALIDATION_ERROR", 400)
  }
  await db
    .updateTable("admin_settings")
    .set({ value: mode, updated_at: new Date().toISOString() })
    .where("key", "=", "signup.mode")
    .execute()
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
