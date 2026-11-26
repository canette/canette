import type { DB } from "../db/db"
import type { BuildLog, Deployment, DeploymentStatus, PaginatedResponse } from "@canette/types"
import type { Insertable, Selectable } from "kysely"
import type { Database } from "../db/types"
import { sql } from "kysely"
import { ServiceError } from "./errors"
import { getAppById } from "./apps"
import { lockIntent, setIntent } from "./intents"

// ── Internal row types (snake_case, never exported) ───────────────────────────

type DeploymentRow = Selectable<Database["deployments"]>
type BuildLogRow = Selectable<Database["build_logs"]>

// ── Mappers ───────────────────────────────────────────────────────────────────

function parseScanSummary(raw: string | null): Deployment["scanSummary"] {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function mapDeployment(row: DeploymentRow, hasSbom = false): Deployment {
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
    scanSummary: parseScanSummary(row.scan_summary),
    hasSbom,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function getSbomSet(db: DB, deploymentIds: string[]): Promise<Set<string>> {
  if (deploymentIds.length === 0) return new Set()
  const rows = await db
    .selectFrom("scan_sboms")
    .select("deployment_id")
    .where("deployment_id", "in", deploymentIds)
    .execute()
  return new Set(rows.map((r) => r.deployment_id))
}

async function hasSbomForId(db: DB, deploymentId: string): Promise<boolean> {
  const row = await db
    .selectFrom("scan_sboms")
    .select("deployment_id")
    .where("deployment_id", "=", deploymentId)
    .executeTakeFirst()
  return !!row
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
  deployment_type: string
  git_url: string
  git_branch: string
  app_path: string
  git_credential_id: string | null
  port: number
  schedule: string | null
  password_gate_enabled: boolean
  password_gate_password_hash: string | null
  project_id: string
  project_slug: string
  project_owner: string
}

// buildSnapshot gathers all data needed by the Go services from the database
// and serialises it as a JSON string stored in deployments.deployment_snapshot.
// This eliminates cross-table joins in the builder and controller at claim time.
async function buildSnapshot(db: DB, appId: string): Promise<string> {
  const appRows = await sql<SnapshotAppRow>`
    SELECT a.id, a.slug, a.source_type, a.deployment_type, a.git_url, a.git_branch,
           a.app_path, a.git_credential_id, a.port, a.schedule,
           a.password_gate_enabled, a.password_gate_password_hash,
           p.id AS project_id, p.slug AS project_slug,
           COALESCE(p.created_by, '') AS project_owner
    FROM apps a
    JOIN projects p ON p.id = a.project_id
    WHERE a.id = ${appId}
  `.execute(db)
  const app = appRows.rows[0]
  if (!app) throw new ServiceError("App not found", "NOT_FOUND", 404)

  const [envRows, volumeRows, hostnameRows] = await Promise.all([
    db
      .selectFrom("env_vars")
      .select(["key", "value"])
      .where("app_id", "=", appId)
      .orderBy("key", "asc")
      .execute(),
    db
      .selectFrom("app_volumes")
      .selectAll()
      .where("app_id", "=", appId)
      .orderBy("created_at", "asc")
      .execute(),
    db
      .selectFrom("app_hostnames")
      .select(["hostname"])
      .where("app_id", "=", appId)
      .orderBy("created_at", "asc")
      .execute(),
  ])
  const envVars = envRows.map((r) => ({ key: r.key, value: r.value }))
  const volumes = volumeRows.map((r) => {
    let config: Record<string, unknown> = {}
    try { config = JSON.parse(r.config) as Record<string, unknown> } catch { /* use empty */ }
    return { id: r.id, name: r.name, type: r.type, mount_path: r.mount_path, config }
  })
  const extraHostnames = hostnameRows.map((r) => r.hostname)

  return JSON.stringify({
    app: {
      id: app.id,
      slug: app.slug,
      source_type: app.source_type,
      deployment_type: app.deployment_type,
      git_url: app.git_url,
      git_branch: app.git_branch,
      app_path: app.app_path,
      git_credential_id: app.git_credential_id ?? null,
      port: app.port,
      schedule: app.schedule ?? null,
      password_gate: {
        enabled: !!app.password_gate_enabled,
        password_hash: app.password_gate_password_hash ?? "",
      },
    },
    project: {
      id: app.project_id,
      slug: app.project_slug,
      owner_id: app.project_owner,
    },
    env_vars: envVars,
    volumes,
    extra_hostnames: extraHostnames,
    resource_defaults: {
      cpu_request: process.env.DEFAULT_CPU_REQUEST ?? "100m",
      memory_request: process.env.DEFAULT_MEMORY_REQUEST ?? "128Mi",
      cpu_limit: process.env.DEFAULT_CPU_LIMIT ?? "500m",
      memory_limit: process.env.DEFAULT_MEMORY_LIMIT ?? "512Mi",
    },
  })
}

// ── Service functions ─────────────────────────────────────────────────────────

// Caller must already have verified the user has access to this app.
export async function listDeployments(
  db: DB,
  appId: string,
  limit = 50
): Promise<PaginatedResponse<Deployment>> {
  const rows = await db
    .selectFrom("deployments")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute()
  const sbomSet = await getSbomSet(db, rows.map((r) => r.id))
  const items = rows.map((row) => mapDeployment(row, sbomSet.has(row.id)))
  return { items, total: items.length, page: 1, pageSize: items.length }
}

// getLiveDeployment returns the deployment currently serving the app, which is
// not necessarily its latest one: a newer rollout may still be in progress or
// have failed. Null when the app is stopped (from the moment Stop is
// recorded, before the controller has torn it down) or has never gone live.
// Callers check access to the app.
export async function getLiveDeployment(db: DB, appId: string): Promise<Deployment | null> {
  const row = await db
    .selectFrom("deployments as d")
    .leftJoin("app_intents as i", "i.app_id", "d.app_id")
    .selectAll("d")
    .where("d.app_id", "=", appId)
    .where("d.status", "=", "live")
    .where((eb) => eb.or([eb("i.desired_state", "is", null), eb("i.desired_state", "=", "running")]))
    .orderBy("d.created_at", "desc")
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return mapDeployment(row, await hasSbomForId(db, row.id))
}

// triggeredBy is a user ID for manual deploys, or null for webhook-triggered deploys.
// When non-null, access is verified via team membership.
// When null (webhook path), the HMAC signature in the receiver is the security gate.
// input is provided by webhooks (real commit data); omit for manual deploys and the
// branch/tag is read from the apps table with commit_message set to 'Manual Deploy'.
// With onlyIfRunning (webhooks), an app whose intent is stopped isn't deployed:
// APP_NOT_RUNNING is thrown instead, checked under the intent lock so a Stop
// that commits while the request is handled wins.
export async function createDeployment(
  db: DB,
  appId: string,
  triggeredBy: string | null,
  input?: { commitSha: string; commitMessage?: string; onlyIfRunning?: boolean }
): Promise<Deployment> {
  if (triggeredBy !== null) {
    const app = await getAppById(db, appId, triggeredBy)
    if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)
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

  let values: Insertable<Database["deployments"]>
  if (appRow?.source_type === "image") {
    const tag = appRow.image_tag || "latest"
    const imageRef = `${appRow.image_url}:${tag}`
    const commitSha = input?.commitSha ?? tag
    // No build stage, insert directly as pending_deployment
    values = {
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
    }
  } else {
    const commitSha = input?.commitSha ?? (appRow?.git_branch || "main")
    // Build stage, image_digest is set once build is complete
    values = {
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
    }
  }
  await startDeployment(db, values, { onlyIfRunning: input?.onlyIfRunning })

  const row = await db
    .selectFrom("deployments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
  return mapDeployment(row)
}

// startDeployment inserts a new attempt and makes it the app's intent target,
// in one transaction, so a deploy is never recorded half way. An attempt still
// in progress isn't refused: the new one supersedes it (#354). The builder
// stops it if it is still building, and the controller never rolls out an
// attempt that isn't the target.
async function startDeployment(
  db: DB,
  values: Insertable<Database["deployments"]>,
  opts: { onlyIfRunning?: boolean } = {}
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await lockIntent(tx, values.app_id)
    if (opts.onlyIfRunning) {
      const intent = await tx
        .selectFrom("app_intents")
        .select("desired_state")
        .where("app_id", "=", values.app_id)
        .executeTakeFirst()
      if (intent?.desired_state !== "running") {
        throw new ServiceError("App is not running", "APP_NOT_RUNNING", 409)
      }
    }
    await tx.insertInto("deployments").values(values).execute()
    await setIntent(tx, values.app_id, {
      desiredState: "running",
      targetDeploymentId: values.id,
      updatedBy: values.triggered_by ?? null,
    })
  })
}

// stopApp stops an app: it records the stop in the app's intent, and the
// controller tears down whatever the app runs (a live deployment, or what a
// failed one left behind) and marks the attempts it stopped. A build or
// rollout in progress doesn't go live afterwards: the builder or the
// controller sees the stopped intent and supersedes or stops it (#354).
// Verifies access itself via app → project → team membership.
export async function stopApp(
  db: DB,
  appId: string,
  userId: string
): Promise<boolean> {
  const access = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p_access", "p_access.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p_access.team_id")
    .select("a.id")
    .where("a.id", "=", appId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!access) return false

  // The controller tears the app down and records the attempts it stopped
  // (#354). Until it has, the app reads "stopping" (lifecycleStatus) and its
  // URL is hidden.
  await db.transaction().execute(async (tx) => {
    await lockIntent(tx, appId)
    await setIntent(tx, appId, { desiredState: "stopped", updatedBy: userId })
  })

  return true
}

// redeployDeployment creates a new deployment row reusing the already-built image
// without triggering a new build. A fresh snapshot is built from current app state
// so that any changes to env vars, ports, or admin settings are picked up.
// Verifies access via deployment → app → project → team membership.
export async function redeployDeployment(
  db: DB,
  deploymentId: string,
  userId: string
): Promise<Deployment | null> {
  const access = await db
    .selectFrom("deployments as d")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("projects as p_access", "p_access.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p_access.team_id")
    .select(["d.id", "d.app_id", "d.status", "d.image_digest", "d.commit_sha", "d.commit_message"])
    .where("d.id", "=", deploymentId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!access) return null

  if (!access.image_digest) {
    throw new ServiceError(
      "Cannot redeploy: this deployment has no built image. Trigger a new deployment instead.",
      "NO_IMAGE_DIGEST",
      409
    )
  }
  if (!["failed", "live", "stopped", "superseded"].includes(access.status)) {
    throw new ServiceError(
      `Cannot redeploy a deployment with status '${access.status}'.`,
      "INVALID_STATUS",
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
  await startDeployment(db, {
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

  const row = await db
    .selectFrom("deployments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
  return mapDeployment(row)
}

// Verifies access via deployment → app → project → team membership.
export async function getDeploymentById(
  db: DB,
  deploymentId: string,
  userId: string
): Promise<Deployment | null> {
  const row = await db
    .selectFrom("deployments as d")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .selectAll("d")
    .where("d.id", "=", deploymentId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return mapDeployment(row, await hasSbomForId(db, row.id))
}

// Access check via deployment → app → project → membership join.
async function canReadDeployment(db: DB, deploymentId: string, userId: string): Promise<boolean> {
  const access = await db
    .selectFrom("deployments as d")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("projects as p_access", "p_access.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p_access.team_id")
    .select("d.id")
    .where("d.id", "=", deploymentId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  return !!access
}

// Verifies access itself via deployment → app → project → membership join.
export async function getDeploymentLogs(
  db: DB,
  deploymentId: string,
  userId: string
): Promise<BuildLog[] | null> {
  if (!(await canReadDeployment(db, deploymentId, userId))) return null

  const rows = await db
    .selectFrom("build_logs")
    .selectAll()
    .where("deployment_id", "=", deploymentId)
    .orderBy("created_at", "asc")
    .execute()
  return rows.map(mapBuildLog)
}

// getDeploymentLogTail returns up to `lines` log lines in order, counted back
// from the end of the log after skipping the newest `skip` lines, so a caller
// can page backwards without loading the whole log. Null without access.
export async function getDeploymentLogTail(
  db: DB,
  deploymentId: string,
  userId: string,
  { lines, skip = 0 }: { lines: number; skip?: number }
): Promise<{ items: BuildLog[]; total: number } | null> {
  if (!(await canReadDeployment(db, deploymentId, userId))) return null

  const [{ total }, rows] = await Promise.all([
    db
      .selectFrom("build_logs")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where("deployment_id", "=", deploymentId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("build_logs")
      .selectAll()
      .where("deployment_id", "=", deploymentId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(lines)
      .offset(skip)
      .execute(),
  ])
  return { items: rows.reverse().map(mapBuildLog), total: Number(total) }
}
