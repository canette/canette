import type { DB } from "../db/db"
import type { App, AppDeploymentType, AppSourceType, PaginatedResponse } from "@canette/types"
import type { Selectable, Updateable } from "kysely"
import type { Database } from "../db/types"
import { sql } from "kysely"
import { ServiceError } from "./errors"
import { getReplicasFromCanetteConfig, validateCanetteConfigYaml } from "./canette-config"
import { supportsForUpdate } from "../db/dialect"
import { lockIntent } from "./intents"
import { lifecycleStatus, type LifecycleColumns } from "./lifecycle-status"
import { AUTHGATE_SIDECAR_PORT } from "./reserved-ports"
import { credentialDestinationError } from "./git-credential-destination"
import { isUniqueConstraintError } from "../db/errors"

// ── Internal row type (snake_case, never exported) ────────────────────────────

// latest_deployment_status is a computed column not in the base table, so we
// extend. The kubernetes_status and runtime_health columns come from
// app_observed_status, which the controller writes (see selectApps). They are
// null when the app has no row there yet. runtime_live_url and the
// LifecycleColumns come from app_runtime (the controller's side), app_intents
// and the deployment the intent targets.
type AppRow = Selectable<Database["apps"]> & LifecycleColumns & {
  latest_deployment_status?: string | null
  runtime_live_url?: string | null
  kubernetes_status?: string | null
  kubernetes_status_observed_at?: string | null
  runtime_health?: string | null
  runtime_health_reason?: string | null
  runtime_health_updated_at?: string | null
}

// ── Mapper ────────────────────────────────────────────────────────────────────

// The controller's health watcher rewrites an unchanged verdict every 5 minutes
// while it can reach Kubernetes (healthRewriteInterval in
// apps/controller/internal/health/watcher.go). A verdict that hasn't been
// confirmed in twice that long means the watcher has stopped observing the
// app (controller down, or cut off from Kubernetes), so it reads as unknown.
const RUNTIME_HEALTH_STALE_AFTER_MS = 10 * 60 * 1000

function effectiveRuntimeHealth(row: AppRow): Pick<App, "runtimeHealth" | "runtimeHealthReason"> {
  const updatedAt = row.runtime_health_updated_at
  if (!row.runtime_health || (updatedAt && Date.now() - new Date(updatedAt).getTime() > RUNTIME_HEALTH_STALE_AFTER_MS)) {
    return { runtimeHealth: "unknown", runtimeHealthReason: undefined }
  }
  return {
    runtimeHealth: row.runtime_health as App["runtimeHealth"],
    runtimeHealthReason: row.runtime_health_reason ?? undefined,
  }
}

// The controller's status reader follows the same rewrite rule as the health
// watcher (apps/controller/internal/health/kubestatus.go), so the same
// staleness window applies. A stale or unparseable reading is left out.
function effectiveKubernetesStatus(row: AppRow): App["kubernetesStatus"] {
  const observedAt = row.kubernetes_status_observed_at
  if (!row.kubernetes_status || !observedAt) return undefined
  if (Date.now() - new Date(observedAt).getTime() > RUNTIME_HEALTH_STALE_AFTER_MS) return undefined
  try {
    return JSON.parse(row.kubernetes_status) as App["kubernetesStatus"]
  } catch {
    return undefined
  }
}

function mapApp(row: AppRow): App {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    sourceType: row.source_type as AppSourceType,
    deploymentType: row.deployment_type as AppDeploymentType,
    gitUrl: row.git_url,
    gitBranch: row.git_branch,
    gitCredentialId: row.git_credential_id ?? undefined,
    appPath: row.app_path,
    imageUrl: row.image_url,
    imageTag: row.image_tag,
    port: row.port,
    schedule: row.schedule ?? undefined,
    // Hidden as soon as the app is stopped, before the controller has torn it
    // down and cleared the URL.
    liveUrl: row.desired_state === "stopped" ? undefined : (row.runtime_live_url ?? undefined),
    latestDeploymentStatus: (row.latest_deployment_status as App["latestDeploymentStatus"]) ?? undefined,
    lifecycleStatus: lifecycleStatus(row),
    canetteConfig: row.canette_config ?? undefined,
    position: row.position,
    ...effectiveRuntimeHealth(row),
    runtimeHealthUpdatedAt: row.runtime_health_updated_at ?? undefined,
    kubernetesStatus: effectiveKubernetesStatus(row),
    kubernetesStatusObservedAt: row.kubernetes_status_observed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// selectApps starts every query that feeds mapApp: the app row plus what the
// controller has observed and done for it. LEFT JOIN, because the controller
// creates its rows only on first use.
function selectApps(db: DB) {
  return db
    .selectFrom("apps as a")
    .leftJoin("app_observed_status as o", "o.app_id", "a.id")
    .leftJoin("app_runtime as r", "r.app_id", "a.id")
    .leftJoin("app_intents as i", "i.app_id", "a.id")
    .leftJoin("deployments as t", "t.id", "i.target_deployment_id")
    .selectAll("a")
    .select([
      "r.live_url as runtime_live_url",
      "r.reconciled_generation",
      "r.applied_deployment_id",
      "i.desired_state",
      "i.generation as intent_generation",
      "t.status as target_status",
      "o.kubernetes_status",
      "o.kubernetes_status_observed_at",
      "o.runtime_health",
      "o.runtime_health_reason",
      "o.runtime_health_updated_at",
    ])
}

// ── Slug validation ───────────────────────────────────────────────────────────

const RESERVED_APP_SLUGS = new Set(["new", "deployments", "settings"])

function isValidAppSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) && !slug.endsWith("-") && !RESERVED_APP_SLUGS.has(slug)
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function isAppSlugAvailable(
  db: DB,
  projectId: string,
  slug: string
): Promise<boolean> {
  if (RESERVED_APP_SLUGS.has(slug)) return false
  const row = await db
    .selectFrom("apps")
    .select("id")
    .where("project_id", "=", projectId)
    .where("slug", "=", slug)
    .executeTakeFirst()
  return !row
}

export async function listApps(
  db: DB,
  projectId: string,
  userId: string
): Promise<PaginatedResponse<App> | null> {
  const membership = await db
    .selectFrom("projects as p")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select("p.id")
    .where("p.id", "=", projectId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!membership) return null

  const rows = await selectApps(db)
    .select((eb) =>
      eb
        .selectFrom("deployments")
        .select("status")
        .whereRef("app_id", "=", "a.id")
        .orderBy("created_at", "desc")
        .limit(1)
        .as("latest_deployment_status")
    )
    .where("a.project_id", "=", projectId)
    .orderBy("a.position", "asc")
    .orderBy("a.created_at", "desc")
    .execute()
  const items = rows.map(mapApp)
  return { items, total: items.length, page: 1, pageSize: items.length }
}

export async function getAppById(
  db: DB,
  appId: string,
  userId: string
): Promise<App | null> {
  const row = await selectApps(db)
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select((eb) =>
      eb
        .selectFrom("deployments")
        .select("status")
        .whereRef("app_id", "=", "a.id")
        .orderBy("created_at", "desc")
        .limit(1)
        .as("latest_deployment_status")
    )
    .where("a.id", "=", appId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return mapApp(row)
}

export async function getAppByRef(
  db: DB,
  projectRef: string,
  appRef: string,
  userId: string
): Promise<App | null> {
  const isUuid = (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
  const projectCol = isUuid(projectRef) ? "p.id" : "p.slug"
  const appCol = isUuid(appRef) ? "a.id" : "a.slug"

  const row = await selectApps(db)
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select((eb) =>
      eb
        .selectFrom("deployments")
        .select("status")
        .whereRef("app_id", "=", "a.id")
        .orderBy("created_at", "desc")
        .limit(1)
        .as("latest_deployment_status")
    )
    .where(sql.ref(projectCol), "=", projectRef)
    .where(sql.ref(appCol), "=", appRef)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return mapApp(row)
}

// Standard 5-field cron OR @-prefixed K8s predefined schedules.
const CRON_RE = /^(@(hourly|daily|weekly|monthly|yearly|annually|midnight)|((\S+) (\S+) (\S+) (\S+) (\S+)))$/

function validateSchedule(schedule: string): void {
  if (!CRON_RE.test(schedule.trim())) {
    throw new ServiceError(
      "schedule must be a valid cron expression (e.g. '0 2 * * *') or a predefined schedule (e.g. '@daily')",
      "VALIDATION_ERROR",
      400
    )
  }
}

function validateCanetteConfig(yaml: string): void {
  if (yaml.length > 10 * 1024) {
    throw new ServiceError("canetteConfig must not exceed 10 KB", "VALIDATION_ERROR", 400)
  }
  // Syntax only — field validation happens in the controller at deploy time.
  validateCanetteConfigYaml(yaml)
}

// Accepted git URL forms:
//   https://host/path          — HTTPS clone URL (most common)
//   git@host:path              — SCP-style SSH (GitHub/GitLab default SSH format)
//   ssh://git@host/path        — explicit SSH scheme (some providers / self-hosted)
// Rejected: http://, file://, anything with whitespace or control characters.
const GIT_URL_RE = /^(https:\/\/[^\s]{1,900}|git@[^:\s]{1,200}:[^\s]{1,700}|ssh:\/\/[^\s]{1,900})$/

function validateGitUrl(url: string): void {
  if (url.length > 1024) {
    throw new ServiceError("gitUrl must not exceed 1024 characters", "VALIDATION_ERROR", 400)
  }
  if (!GIT_URL_RE.test(url)) {
    throw new ServiceError(
      "gitUrl must be a valid HTTPS (https://…) or SSH (git@host:path or ssh://…) URL",
      "VALIDATION_ERROR",
      400
    )
  }
}

// Rejects a git credential the caller's team can't use, or one that must not be
// sent to the host in `gitUrl` (see git-credential-destination.ts).
async function assertGitCredentialUsable(
  db: DB,
  credentialId: string,
  teamId: string,
  gitUrl: string,
): Promise<void> {
  const credential = await db
    .selectFrom("git_credentials")
    .select(["team_id", "provider", "type"])
    .where("id", "=", credentialId)
    .executeTakeFirst()

  if (!credential) {
    throw new ServiceError("Git credential not found", "VALIDATION_ERROR", 400)
  }
  // team_id null means system credential — accessible to everyone
  if (credential.team_id !== null && credential.team_id !== teamId) {
    throw new ServiceError("Git credential not found", "VALIDATION_ERROR", 400)
  }
  const destinationError = credentialDestinationError(credential, gitUrl)
  if (destinationError) {
    throw new ServiceError(destinationError, "VALIDATION_ERROR", 400)
  }
}

export async function createApp(
  db: DB,
  projectId: string,
  userId: string,
  input: {
    name: string
    slug: string
    sourceType?: AppSourceType
    deploymentType?: AppDeploymentType
    gitUrl?: string
    gitBranch?: string
    gitCredentialId?: string
    appPath?: string
    imageUrl?: string
    imageTag?: string
    port?: number
    schedule?: string
    canetteConfig?: string
  }
): Promise<App> {
  if (!input.name?.trim()) throw new ServiceError("name is required", "VALIDATION_ERROR", 400)
  if (!input.slug || !isValidAppSlug(input.slug)) {
    throw new ServiceError(
      "slug is required and must be lowercase alphanumeric and hyphens (max 63 chars)",
      "VALIDATION_ERROR",
      400
    )
  }

  const sourceType: AppSourceType = input.sourceType ?? "git"
  if (sourceType !== "git" && sourceType !== "image") {
    throw new ServiceError("sourceType must be 'git' or 'image'", "VALIDATION_ERROR", 400)
  }
  const deploymentType: AppDeploymentType = input.deploymentType ?? "web"
  if (!["web", "private", "cronjob"].includes(deploymentType)) {
    throw new ServiceError("deploymentType must be 'web', 'private', or 'cronjob'", "VALIDATION_ERROR", 400)
  }
  if (deploymentType === "cronjob" && !input.schedule?.trim()) {
    throw new ServiceError("schedule is required for cronjob deployment type", "VALIDATION_ERROR", 400)
  }
  if (input.schedule?.trim()) validateSchedule(input.schedule.trim())
  if (sourceType === "git" && !input.gitUrl?.trim()) {
    throw new ServiceError("gitUrl is required for git source type", "VALIDATION_ERROR", 400)
  }
  if (sourceType === "git" && input.gitUrl) validateGitUrl(input.gitUrl.trim())
  if (sourceType === "image" && !input.imageUrl?.trim()) {
    throw new ServiceError("imageUrl is required for image source type", "VALIDATION_ERROR", 400)
  }
  const port = input.port ?? 3000
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceError("port must be an integer between 1 and 65535", "VALIDATION_ERROR", 400)
  }
  if (port === AUTHGATE_SIDECAR_PORT) {
    throw new ServiceError(`port ${AUTHGATE_SIDECAR_PORT} is reserved for the password-gate sidecar`, "VALIDATION_ERROR", 400)
  }
  if (input.canetteConfig) validateCanetteConfig(input.canetteConfig)

  const membership = await db
    .selectFrom("projects as p")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select(["p.id", "p.team_id"])
    .where("p.id", "=", projectId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()

  if (!membership) throw new ServiceError("Not found", "NOT_FOUND", 404)

  // The controller cleans a deleted app up by slug, so a new app may not take
  // the slug until that has finished, or the cleanup would remove its resources.
  const pendingCleanup = await db
    .selectFrom("queued_app_cleanups")
    .select("id")
    .where("project_id", "=", projectId)
    .where("app_slug", "=", input.slug)
    .executeTakeFirst()
  if (pendingCleanup) {
    throw new ServiceError(
      "An app with that slug was just deleted and is still being cleaned up. Try again in a minute.",
      "CONFLICT",
      409
    )
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  // New apps append to the end of the project's manual order.
  const maxPosition = await db
    .selectFrom("apps")
    .select((eb) => eb.fn.max("position").as("maxPosition"))
    .where("project_id", "=", projectId)
    .executeTakeFirst()
  const position = (maxPosition?.maxPosition ?? -1) + 1

  if (input.gitCredentialId) {
    await assertGitCredentialUsable(
      db,
      input.gitCredentialId,
      membership.team_id,
      sourceType === "git" ? (input.gitUrl?.trim() ?? "") : "",
    )
  }

  try {
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto("apps")
        .values({
          id,
          project_id: projectId,
          name: input.name.trim(),
          slug: input.slug,
          source_type: sourceType,
          deployment_type: deploymentType,
          git_url: sourceType === "git" ? (input.gitUrl?.trim() ?? "") : "",
          git_branch: sourceType === "git" ? (input.gitBranch ?? "main") : "main",
          git_credential_id: input.gitCredentialId ?? null,
          app_path: sourceType === "git" ? (input.appPath ?? "") : "",
          image_url: sourceType === "image" ? (input.imageUrl?.trim() ?? "") : "",
          image_tag: sourceType === "image" ? (input.imageTag?.trim() ?? "latest") : "",
          port,
          schedule: deploymentType === "cronjob" ? (input.schedule?.trim() ?? null) : null,
          position,
          password_gate_enabled: false,
          password_gate_password_hash: null,
          canette_config: input.canetteConfig ?? null,
          created_at: now,
          updated_at: now,
        })
        .execute()
      // A new app is stopped until its first deploy (see services/intents.ts).
      await tx
        .insertInto("app_intents")
        .values({ app_id: id, generation: 0, desired_state: "stopped", updated_at: now })
        .execute()
    })
  } catch (err: unknown) {
    if (isUniqueConstraintError(err)) {
      throw new ServiceError("An app with that slug already exists in this project", "CONFLICT", 409)
    }
    throw err
  }

  const row = await selectApps(db)
    .where("a.id", "=", id)
    .executeTakeFirstOrThrow()
  return mapApp(row)
}

export async function updateApp(
  db: DB,
  appId: string,
  userId: string,
  patch: {
    name?: string
    sourceType?: AppSourceType
    deploymentType?: AppDeploymentType
    gitUrl?: string
    gitBranch?: string
    appPath?: string
    imageUrl?: string
    imageTag?: string
    port?: number
    schedule?: string | null    // null clears it, undefined leaves unchanged
    gitCredentialId?: string | null  // null clears it, undefined leaves unchanged
    canetteConfig?: string | null    // null clears it, undefined leaves unchanged
  }
): Promise<App | null> {
  const app = await getAppById(db, appId, userId)

  //Does the app exist and the user has access
  if (!app) return null

  if (patch.sourceType !== undefined && patch.sourceType !== "git" && patch.sourceType !== "image") {
    throw new ServiceError("sourceType must be 'git' or 'image'", "VALIDATION_ERROR", 400)
  }
  if (patch.deploymentType !== undefined && !["web", "private", "cronjob"].includes(patch.deploymentType)) {
    throw new ServiceError("deploymentType must be 'web', 'private', or 'cronjob'", "VALIDATION_ERROR", 400)
  }
  if (patch.deploymentType !== undefined && patch.deploymentType !== app.deploymentType) {
    if (app.deploymentType === "cronjob" || patch.deploymentType === "cronjob") {
      throw new ServiceError(
        "Cannot change deployment type to or from 'cronjob'",
        "VALIDATION_ERROR",
        400
      )
    }
  }
  const effectiveDeploymentType = patch.deploymentType ?? app.deploymentType
  if (effectiveDeploymentType === "cronjob") {
    const effectiveSchedule = patch.schedule !== undefined ? patch.schedule : app.schedule
    if (!effectiveSchedule?.trim()) {
      throw new ServiceError("schedule is required for cronjob deployment type", "VALIDATION_ERROR", 400)
    }
  }
  if (patch.schedule != null && patch.schedule.trim()) validateSchedule(patch.schedule.trim())
  if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
    throw new ServiceError("port must be an integer between 1 and 65535", "VALIDATION_ERROR", 400)
  }
  if (patch.port === AUTHGATE_SIDECAR_PORT) {
    throw new ServiceError(`port ${AUTHGATE_SIDECAR_PORT} is reserved for the password-gate sidecar`, "VALIDATION_ERROR", 400)
  }
  if (patch.gitUrl !== undefined && patch.gitUrl.trim()) validateGitUrl(patch.gitUrl.trim())
  if (patch.canetteConfig) validateCanetteConfig(patch.canetteConfig)

  if (patch.gitUrl !== undefined && patch.gitUrl.trim() !== app.gitUrl) {
    const webhook = await db
      .selectFrom("webhook_secrets")
      .select("id")
      .where("app_id", "=", appId)
      .executeTakeFirst()
    if (webhook) {
      throw new ServiceError(
        "Cannot change the repository URL while a webhook is configured. Remove the webhook first.",
        "WEBHOOK_EXISTS",
        400
      )
    }
  }

  // Re-check the credential whenever the credential, repository URL or source
  // type changes — a new URL must not redirect an existing credential to an
  // unapproved host.
  const effectiveCredentialId =
    patch.gitCredentialId !== undefined ? patch.gitCredentialId : (app.gitCredentialId ?? null)
  const credentialOrDestinationChanged =
    patch.gitCredentialId !== undefined || patch.gitUrl !== undefined || patch.sourceType !== undefined
  if (effectiveCredentialId && credentialOrDestinationChanged) {
    const project = await db
      .selectFrom("projects")
      .select("team_id")
      .where("id", "=", app.projectId)
      .executeTakeFirstOrThrow()

    const effectiveSourceType = patch.sourceType ?? app.sourceType
    const effectiveGitUrl = patch.gitUrl !== undefined ? patch.gitUrl.trim() : app.gitUrl
    await assertGitCredentialUsable(
      db,
      effectiveCredentialId,
      project.team_id,
      effectiveSourceType === "git" ? effectiveGitUrl : "",
    )
  }

  const updates: Updateable<Database["apps"]> = {}
  if (patch.name !== undefined)            updates.name = patch.name.trim()
  if (patch.sourceType !== undefined)      updates.source_type = patch.sourceType
  if (patch.deploymentType !== undefined)  updates.deployment_type = patch.deploymentType
  if (patch.gitUrl !== undefined)          updates.git_url = patch.gitUrl.trim()
  if (patch.gitBranch !== undefined)       updates.git_branch = patch.gitBranch.trim()
  if (patch.appPath !== undefined)         updates.app_path = patch.appPath
  if (patch.imageUrl !== undefined)        updates.image_url = patch.imageUrl.trim()
  if (patch.imageTag !== undefined)        updates.image_tag = patch.imageTag.trim()
  if (patch.port !== undefined)            updates.port = patch.port
  if (patch.schedule !== undefined)        updates.schedule = patch.schedule?.trim() || null
  if (patch.gitCredentialId !== undefined) updates.git_credential_id = patch.gitCredentialId
  if (patch.canetteConfig !== undefined)   updates.canette_config = patch.canetteConfig
  if (!Object.keys(updates).length) throw new ServiceError("Nothing to update", "VALIDATION_ERROR", 400)
  updates.updated_at = new Date().toISOString()

  // When canetteConfig changes, we must check the PVC/replicas invariant inside
  // the same transaction as the UPDATE to avoid a TOCTOU race with concurrent
  // POST /volumes (which locks the apps row before inserting a PVC). Other
  // updates don't need the row lock — pay the transaction cost only when needed.
  const needsPvcCheck = patch.canetteConfig !== undefined && patch.canetteConfig !== null
  if (needsPvcCheck) {
    await db.transaction().execute(async (tx) => {
      let lockQ = tx
        .selectFrom("apps")
        .select("id")
        .where("id", "=", appId)
      if (supportsForUpdate(tx)) lockQ = lockQ.forUpdate()
      await lockQ.executeTakeFirstOrThrow()
      const newReplicas = getReplicasFromCanetteConfig(patch.canetteConfig)
      if (newReplicas > 1) {
        const pvcVolume = await tx
          .selectFrom("app_volumes")
          .select("id")
          .where("app_id", "=", appId)
          .where("type", "=", "pvc")
          .executeTakeFirst()
        if (pvcVolume) {
          throw new ServiceError(
            "Cannot set replicas > 1 while the app has PVC volumes. Remove PVC volumes first or keep replicas at 1.",
            "PVC_REPLICAS_CONFLICT",
            422
          )
        }
      }
      await tx.updateTable("apps").set(updates).where("id", "=", appId).execute()
    })
  } else {
    await db.updateTable("apps").set(updates).where("id", "=", appId).execute()
  }

  const row = await selectApps(db)
    .where("a.id", "=", appId)
    .executeTakeFirstOrThrow()
  return mapApp(row)
}

// Swaps an app with its adjacent neighbor in the project's manual order (the
// order returned by listApps). Renumbers every app in the project to dense
// 0..N-1 positions in the same transaction — cheap at realistic project sizes,
// and it's what resolves the all-zero position tie new/pre-existing apps start
// with, without needing a dialect-sensitive backfill migration.
export async function moveApp(
  db: DB,
  appId: string,
  userId: string,
  direction: "up" | "down"
): Promise<App[] | null> {
  const app = await getAppById(db, appId, userId)
  if (!app) return null

  const rows = await db
    .selectFrom("apps")
    .select("id")
    .where("project_id", "=", app.projectId)
    .orderBy("position", "asc")
    .orderBy("created_at", "desc")
    .execute()
  const ids = rows.map((r) => r.id)
  const idx = ids.indexOf(appId)
  const swapIdx = direction === "up" ? idx - 1 : idx + 1

  if (swapIdx >= 0 && swapIdx < ids.length) {
    ;[ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]]
    await db.transaction().execute(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.updateTable("apps").set({ position: i }).where("id", "=", ids[i]).execute()
      }
    })
  }

  return (await listApps(db, app.projectId, userId))?.items ?? []
}

export async function deleteApp(
  db: DB,
  appId: string,
  userId: string
): Promise<boolean> {
  const app = await getAppById(db, appId, userId)
  if (!app) return false

  await db.transaction().execute(async (tx) => {
    // The intent row first, like every lifecycle action (services/intents.ts).
    await lockIntent(tx, appId)
    let lockQ = tx
      .selectFrom("apps as a")
      .innerJoin("projects as p", "p.id", "a.project_id")
      .select(["a.slug", "p.id as project_id", "p.slug as project_slug"])
      .where("a.id", "=", appId)
    if (supportsForUpdate(tx)) lockQ = lockQ.forUpdate()
    const row = await lockQ.executeTakeFirst()
    if (!row) throw new ServiceError("Not found", "NOT_FOUND", 404)

    // The intent says whether the app should be running, locked above so no
    // deploy is accepted meanwhile. Deployment statuses can't tell: an older
    // live deployment keeps running when a newer one fails, and a stopped
    // app can still have a build being cancelled.
    const intent = await tx
      .selectFrom("app_intents")
      .select("desired_state")
      .where("app_id", "=", appId)
      .executeTakeFirst()
    if (intent?.desired_state === "running") {
      throw new ServiceError(
        "Stop the app before deleting it",
        "CONFLICT",
        409
      )
    }

    // The delete cascades the deployments, so the controller tears the app's
    // K8s resources down from this row instead (see migration 000020).
    await tx
      .insertInto("queued_app_cleanups")
      .values({
        id: crypto.randomUUID(),
        project_id: row.project_id,
        project_slug: row.project_slug,
        app_slug: row.slug,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute()

    await tx
      .deleteFrom("apps")
      .where("id", "=", appId)
      .execute()
  })
  return true
}
