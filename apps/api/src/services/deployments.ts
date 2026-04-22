import type { Db } from "../db"
import type { BuildLog, Deployment, DeploymentStatus, PaginatedResponse } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db-types"
import { sql } from "kysely"
import { ServiceError } from "./errors"
import { getAppById } from "./apps"

// ── Internal row types (snake_case, never exported) ───────────────────────────

type DeploymentRow = Selectable<Database["deployments"]>
type BuildLogRow = Selectable<Database["build_logs"]>

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    appId: row.app_id,
    status: row.status as DeploymentStatus,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message ?? undefined,
    imageDigest: row.image_digest ?? undefined,
    triggeredBy: row.triggered_by ?? undefined,
    errorMessage: row.error_message ?? undefined,
    scanStatus: (row.scan_status ?? undefined) as Deployment["scanStatus"],
    scanSummary: row.scan_summary ? JSON.parse(row.scan_summary) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapBuildLog(row: BuildLogRow): BuildLog {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    createdAt: row.created_at,
    line: row.line,
  }
}

// ── Snapshot builder ──────────────────────────────────────────────────────────

interface SnapshotAppRow {
  id: string
  slug: string
  source_type: string
  git_url: string
  git_branch: string
  app_path: string
  git_credential_id: string | null
  port: number
  project_id: string
  project_slug: string
  project_owner: string
}

// buildSnapshot gathers all data needed by the Go services from the database
// and serialises it as a JSON string stored in deployments.deployment_snapshot.
// This eliminates cross-table joins in the builder and controller at claim time.
async function buildSnapshot(db: Db, appId: string): Promise<string> {
  const appRows = await sql<SnapshotAppRow>`
    SELECT a.id, a.slug, a.source_type, a.git_url, a.git_branch,
           a.app_path, a.git_credential_id, a.port,
           p.id AS project_id, p.slug AS project_slug,
           COALESCE(p.created_by, '') AS project_owner
    FROM apps a
    JOIN projects p ON p.id = a.project_id
    WHERE a.id = ${appId}
  `.execute(db)
  const app = appRows.rows[0]
  if (!app) throw new ServiceError("App not found", "NOT_FOUND", 404)

  const envRows = await db
    .selectFrom("env_vars")
    .select(["key", "value"])
    .where("app_id", "=", appId)
    .orderBy("key", "asc")
    .execute()
  const envVars = envRows.map((r) => ({ key: r.key, value: r.value }))

  const securityRows = await db
    .selectFrom("admin_settings")
    .select(["key", "value"])
    .where("key", "like", "security.%")
    .execute()
  const securitySettings = Object.fromEntries(securityRows.map((r) => [r.key, r.value]))

  return JSON.stringify({
    app: {
      id: app.id,
      slug: app.slug,
      source_type: app.source_type,
      git_url: app.git_url,
      git_branch: app.git_branch,
      app_path: app.app_path,
      git_credential_id: app.git_credential_id ?? null,
      port: app.port,
    },
    project: {
      id: app.project_id,
      slug: app.project_slug,
      owner_id: app.project_owner,
    },
    env_vars: envVars,
    resource_defaults: {
      cpu_request: process.env.DEFAULT_CPU_REQUEST ?? "100m",
      memory_request: process.env.DEFAULT_MEMORY_REQUEST ?? "128Mi",
      cpu_limit: process.env.DEFAULT_CPU_LIMIT ?? "500m",
      memory_limit: process.env.DEFAULT_MEMORY_LIMIT ?? "512Mi",
    },
    scan_policy: {
      scan_enabled: securitySettings["security.scan_enabled"] === "true",
      scan_mandatory: securitySettings["security.scan_mandatory"] === "true",
      fail_severity: securitySettings["security.fail_severity"] ?? "CRITICAL",
    },
  })
}

// ── Service functions ─────────────────────────────────────────────────────────

// Caller must already have verified the user has access to this app.
export async function listDeployments(
  db: Db,
  appId: string
): Promise<PaginatedResponse<Deployment>> {
  const rows = await db
    .selectFrom("deployments")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("created_at", "desc")
    .limit(50)
    .execute()
  const items = rows.map(mapDeployment)
  return { items, total: items.length, page: 1, pageSize: items.length }
}

// hasActiveDeployment returns true if the app already has an in-progress deployment.
async function hasActiveDeployment(db: Db, appId: string): Promise<boolean> {
  const row = await db
    .selectFrom("deployments")
    .select("id")
    .where("app_id", "=", appId)
    .where("status", "in", ["pending_build", "building", "scanning", "pending_deployment", "deploying"])
    .limit(1)
    .executeTakeFirst()
  return !!row
}

// triggeredBy is a user ID for manual deploys, or null for webhook-triggered deploys.
// When non-null, access is verified against the memberships table.
// When null (webhook path), the HMAC signature in the receiver is the security gate.
// input is provided by webhooks (real commit data); omit for manual deploys and the
// branch/tag is read from the apps table with commit_message set to 'Manual Deploy'.
export async function createDeployment(
  db: Db,
  appId: string,
  triggeredBy: string | null,
  input?: { commitSha: string; commitMessage?: string }
): Promise<Deployment> {
  if (triggeredBy !== null) {
    const app = await getAppById(db, appId, triggeredBy)
    if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)
  }

  if (await hasActiveDeployment(db, appId)) {
    throw new ServiceError(
      "A deployment is already in progress. Stop or wait for it to finish first.",
      "DEPLOYMENT_IN_PROGRESS",
      409
    )
  }

  const appRow = await db
    .selectFrom("apps")
    .select(["source_type", "image_url", "image_tag", "git_branch", "canette_config"])
    .where("id", "=", appId)
    .executeTakeFirst()

  const snapshot = await buildSnapshot(db, appId)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const canetteConfig = appRow?.canette_config ?? null
  const commitMessage = input?.commitMessage ?? "Manual Deploy"

  if (appRow?.source_type === "image") {
    const tag = appRow.image_tag || "latest"
    const imageRef = `${appRow.image_url}:${tag}`
    const commitSha = input?.commitSha ?? tag
    // No build stage, insert directly as pending_deployment
    await db
      .insertInto("deployments")
      .values({
        id,
        app_id: appId,
        status: "pending_deployment",
        commit_sha: commitSha,
        commit_message: commitMessage,
        image_digest: imageRef,
        triggered_by: triggeredBy,
        canette_config: canetteConfig,
        deployment_snapshot: snapshot,
        created_at: now,
        updated_at: now,
      })
      .execute()
  } else {
    const commitSha = input?.commitSha ?? (appRow?.git_branch || "main")
    // Build stage, image_digest is set once build is complete
    await db
      .insertInto("deployments")
      .values({
        id,
        app_id: appId,
        status: "pending_build",
        commit_sha: commitSha,
        commit_message: commitMessage,
        triggered_by: triggeredBy,
        canette_config: canetteConfig,
        deployment_snapshot: snapshot,
        created_at: now,
        updated_at: now,
      })
      .execute()
  }

  const row = await db
    .selectFrom("deployments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
  return mapDeployment(row)
}

// stopApp gracefully stops a live deployment (→ 'stopped', triggers K8s teardown).
// Any in-progress build is left running — if it completes it will redeploy the app.
// Verifies access itself via app → project → membership.
export async function stopApp(
  db: Db,
  appId: string,
  userId: string
): Promise<boolean> {
  const access = await db
    .selectFrom("apps as a")
    .innerJoin("memberships as m", "m.project_id", "a.project_id")
    .select("a.id")
    .where("a.id", "=", appId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!access) return false

  const now = new Date().toISOString()

  // Live → stopped (controller will delete K8s resources)
  await db
    .updateTable("deployments")
    .set({ status: "stopped", error_message: null, updated_at: now })
    .where("app_id", "=", appId)
    .where("status", "=", "live")
    .execute()

  // Clear the live URL immediately so the UI reflects the stopped state
  await db
    .updateTable("apps")
    .set({ live_url: null })
    .where("id", "=", appId)
    .execute()

  return true
}

// redeployDeployment creates a new deployment row reusing the already-built image
// without triggering a new build. A fresh snapshot is built from current app state
// so that any changes to env vars, ports, or admin settings are picked up.
// Verifies access via deployment → app → project → membership.
export async function redeployDeployment(
  db: Db,
  deploymentId: string,
  userId: string
): Promise<Deployment | null> {
  const access = await db
    .selectFrom("deployments as d")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("memberships as m", "m.project_id", "a.project_id")
    .select(["d.id", "d.app_id", "d.status", "d.image_digest", "d.commit_sha", "d.commit_message"])
    .where("d.id", "=", deploymentId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!access) return null

  if (!access.image_digest) {
    throw new ServiceError(
      "Cannot redeploy: this deployment has no built image. Trigger a new deployment instead.",
      "NO_IMAGE_DIGEST",
      409
    )
  }
  if (access.status !== "failed" && access.status !== "live" && access.status !== "stopped") {
    throw new ServiceError(
      `Cannot redeploy a deployment with status '${access.status}'.`,
      "INVALID_STATUS",
      409
    )
  }
  if (await hasActiveDeployment(db, access.app_id)) {
    throw new ServiceError(
      "A deployment is already in progress. Stop it first.",
      "DEPLOYMENT_IN_PROGRESS",
      409
    )
  }

  // Fetch current app canette_config and build a fresh snapshot reflecting current state.
  const appRow = await db
    .selectFrom("apps")
    .select("canette_config")
    .where("id", "=", access.app_id)
    .executeTakeFirst()
  const canetteConfig = appRow?.canette_config ?? null
  const snapshot = await buildSnapshot(db, access.app_id)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db
    .insertInto("deployments")
    .values({
      id,
      app_id: access.app_id,
      status: "pending_deployment",
      commit_sha: access.commit_sha,
      commit_message: access.commit_message ?? null,
      image_digest: access.image_digest,
      triggered_by: userId,
      canette_config: canetteConfig,
      deployment_snapshot: snapshot,
      created_at: now,
      updated_at: now,
    })
    .execute()

  const row = await db
    .selectFrom("deployments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
  return mapDeployment(row)
}

// Verifies access itself via deployment → app → project → membership join.
export async function getDeploymentLogs(
  db: Db,
  deploymentId: string,
  userId: string
): Promise<BuildLog[] | null> {
  const access = await db
    .selectFrom("deployments as d")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("memberships as m", "m.project_id", "a.project_id")
    .select(["d.id", "d.commit_sha"])
    .where("d.id", "=", deploymentId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!access) return null

  const rows = await db
    .selectFrom("build_logs")
    .selectAll()
    .where("deployment_id", "=", deploymentId)
    .orderBy("created_at", "asc")
    .execute()
  return rows.map(mapBuildLog)
}
