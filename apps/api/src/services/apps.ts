import type { DB } from "../db/db"
import type { App, AppSourceType, PaginatedResponse } from "@canette/types"
import type { Selectable, Updateable } from "kysely"
import type { Database } from "../db/types"
import { sql } from "kysely"
import { ServiceError } from "./errors"

// ── Internal row type (snake_case, never exported) ────────────────────────────

// latest_deployment_status is a computed column not in the base table, so we extend.
type AppRow = Selectable<Database["apps"]> & { latest_deployment_status?: string | null }

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapApp(row: AppRow): App {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    sourceType: row.source_type as AppSourceType,
    gitUrl: row.git_url,
    gitBranch: row.git_branch,
    gitCredentialId: row.git_credential_id ?? undefined,
    appPath: row.app_path,
    imageUrl: row.image_url,
    imageTag: row.image_tag,
    port: row.port,
    liveUrl: row.live_url ?? undefined,
    latestDeploymentStatus: (row.latest_deployment_status as App["latestDeploymentStatus"]) ?? undefined,
    canetteConfig: row.canette_config ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Slug validation ───────────────────────────────────────────────────────────

function isValidAppSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) && !slug.endsWith("-")
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function isAppSlugAvailable(
  db: DB,
  projectId: string,
  slug: string
): Promise<boolean> {
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

  const rows = await db
    .selectFrom("apps as a")
    .selectAll("a")
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
  const row = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .selectAll("a")
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

  const row = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .selectAll("a")
    .where(sql.ref(projectCol), "=", projectRef)
    .where(sql.ref(appCol), "=", appRef)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return mapApp(row)
}

function validateCanetteConfig(yaml: string): void {
  // Basic size guard — full YAML parsing happens in the controller at deploy time.
  if (yaml.length > 10 * 1024) {
    throw new ServiceError("canetteConfig must not exceed 10 KB", "VALIDATION_ERROR", 400)
  }
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

export async function createApp(
  db: DB,
  projectId: string,
  userId: string,
  input: {
    name: string
    slug: string
    sourceType?: AppSourceType
    gitUrl?: string
    gitBranch?: string
    gitCredentialId?: string
    appPath?: string
    imageUrl?: string
    imageTag?: string
    port?: number
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
  if (input.canetteConfig) validateCanetteConfig(input.canetteConfig)

  const membership = await db
    .selectFrom("projects as p")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select(["p.id", "p.team_id"])
    .where("p.id", "=", projectId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()

  if (!membership) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  if (input.gitCredentialId) {
    const credential = await db
      .selectFrom("git_credentials")
      .select("team_id")
      .where("id", "=", input.gitCredentialId)
      .executeTakeFirst()

    if (!credential) {
      throw new ServiceError("Git credential not found", "VALIDATION_ERROR", 400)
    }
    // team_id null means system credential — accessible to everyone
    if (credential.team_id !== null && credential.team_id !== membership.team_id) {
      throw new ServiceError("Git credential not found", "VALIDATION_ERROR", 400)
    }
  }

  try {
    await db
      .insertInto("apps")
      .values({
        id,
        project_id: projectId,
        name: input.name.trim(),
        slug: input.slug,
        source_type: sourceType,
        git_url: sourceType === "git" ? (input.gitUrl?.trim() ?? "") : "",
        git_branch: sourceType === "git" ? (input.gitBranch ?? "main") : "main",
        git_credential_id: input.gitCredentialId ?? null,
        app_path: sourceType === "git" ? (input.appPath ?? "") : "",
        image_url: sourceType === "image" ? (input.imageUrl?.trim() ?? "") : "",
        image_tag: sourceType === "image" ? (input.imageTag?.trim() ?? "latest") : "",
        port,
        canette_config: input.canetteConfig ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute()
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new ServiceError("An app with that slug already exists in this project", "CONFLICT", 409)
    }
    throw err
  }

  const row = await db
    .selectFrom("apps")
    .selectAll()
    .where("id", "=", id)
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
    gitUrl?: string
    gitBranch?: string
    appPath?: string
    imageUrl?: string
    imageTag?: string
    port?: number
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
  if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
    throw new ServiceError("port must be an integer between 1 and 65535", "VALIDATION_ERROR", 400)
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

  if (patch.gitCredentialId !== undefined && patch.gitCredentialId !== null) {
    const project = await db
      .selectFrom("projects")
      .select("team_id")
      .where("id", "=", app.projectId)
      .executeTakeFirstOrThrow()

    const credential = await db
      .selectFrom("git_credentials")
      .select("team_id")
      .where("id", "=", patch.gitCredentialId)
      .executeTakeFirst()

    if (!credential) {
      throw new ServiceError("Git credential not found", "VALIDATION_ERROR", 400)
    }
    // team_id null means system credential — accessible to everyone
    if (credential.team_id !== null && credential.team_id !== project.team_id) {
      throw new ServiceError("Git credential not found", "VALIDATION_ERROR", 400)
    }
  }

  const updates: Updateable<Database["apps"]> = {}
  if (patch.name !== undefined)            updates.name = patch.name.trim()
  if (patch.sourceType !== undefined)      updates.source_type = patch.sourceType
  if (patch.gitUrl !== undefined)          updates.git_url = patch.gitUrl.trim()
  if (patch.gitBranch !== undefined)       updates.git_branch = patch.gitBranch.trim()
  if (patch.appPath !== undefined)         updates.app_path = patch.appPath
  if (patch.imageUrl !== undefined)        updates.image_url = patch.imageUrl.trim()
  if (patch.imageTag !== undefined)        updates.image_tag = patch.imageTag.trim()
  if (patch.port !== undefined)            updates.port = patch.port
  if (patch.gitCredentialId !== undefined) updates.git_credential_id = patch.gitCredentialId
  if (patch.canetteConfig !== undefined)   updates.canette_config = patch.canetteConfig
  if (!Object.keys(updates).length) throw new ServiceError("Nothing to update", "VALIDATION_ERROR", 400)
  updates.updated_at = new Date().toISOString()

  await db
    .updateTable("apps")
    .set(updates)
    .where("id", "=", appId)
    .execute()

  const row = await db
    .selectFrom("apps")
    .selectAll()
    .where("id", "=", appId)
    .executeTakeFirstOrThrow()
  return mapApp(row)
}

export async function deleteApp(
  db: DB,
  appId: string,
  userId: string
): Promise<boolean> {
  const app = await getAppById(db, appId, userId)
  if (!app) return false

  const latest = await db
    .selectFrom("deployments")
    .select("status")
    .where("app_id", "=", appId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst()
  const latestStatus = latest?.status
  if (latestStatus === "live" || latestStatus === "deploying" || latestStatus === "building") {
    throw new ServiceError(
      "Stop the app before deleting it",
      "CONFLICT",
      409
    )
  }

  await db
    .deleteFrom("apps")
    .where("id", "=", appId)
    .execute()
  return true
}
