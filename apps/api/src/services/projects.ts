import type { DB } from "../db/db"
import type { PaginatedResponse, Project } from "@canette/types"
import type { Selectable, Updateable } from "kysely"
import type { Database } from "../db/types"
import { sql } from "kysely"
import { ServiceError } from "./errors"
import { appNamespace } from "../utils/k8s"
import { isTeamMember } from "./membership"

// ── Internal row type (snake_case, never exported) ────────────────────────────

type ProjectRow = Selectable<Database["projects"]>

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Slug validation ───────────────────────────────────────────────────────────

const RESERVED_PROJECT_SLUGS = new Set(["new", "settings"])

function isValidProjectSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,49}$/.test(slug) && !slug.endsWith("-") && !RESERVED_PROJECT_SLUGS.has(slug)
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function listProjects(
  db: DB,
  userId: string
): Promise<PaginatedResponse<Project>> {
  const rows = await db
    .selectFrom("projects as p")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .selectAll("p")
    .where("tm.user_id", "=", userId)
    .orderBy("p.created_at", "desc")
    .execute()
  const items = rows.map(mapProject)
  return { items, total: items.length, page: 1, pageSize: items.length }
}

export async function getProjectByRef(
  db: DB,
  ref: string,
  userId: string
): Promise<Project | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref)
  const col = isUuid ? "p.id" : "p.slug"
  const row = await db
    .selectFrom("projects as p")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .selectAll("p")
    .where(sql.ref(col), "=", ref)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return mapProject(row)
}

export async function isProjectSlugAvailable(db: DB, slug: string): Promise<boolean> {
  if (RESERVED_PROJECT_SLUGS.has(slug)) return false
  const row = await db
    .selectFrom("projects")
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirst()
  return !row
}

export async function createProject(
  db: DB,
  userId: string,
  input: { teamId: string; name: string; slug: string; description?: string }
): Promise<Project> {
  if (!input.name?.trim()) {
    throw new ServiceError("name is required", "VALIDATION_ERROR", 400)
  }
  if (!input.slug || !isValidProjectSlug(input.slug)) {
    throw new ServiceError(
      "slug is required and must be lowercase alphanumeric and hyphens (max 50 chars)",
      "VALIDATION_ERROR",
      400
    )
  }
  if (!input.teamId) {
    throw new ServiceError("teamId is required", "VALIDATION_ERROR", 400)
  }

  const member = await isTeamMember(db, input.teamId, userId)
  if (!member) {
    throw new ServiceError("Team not found", "NOT_FOUND", 404)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    await db
      .insertInto("projects")
      .values({
        id,
        team_id: input.teamId,
        name: input.name.trim(),
        slug: input.slug,
        description: input.description ?? null,
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .execute()
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new ServiceError("A project with that slug already exists", "CONFLICT", 409)
    }
    throw err
  }

  const row = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
  return mapProject(row)
}

export async function updateProject(
  db: DB,
  projectId: string,
  userId: string,
  patch: { name?: string; description?: string; slug?: string }
): Promise<Project> {
  // Access check via team membership
  const project = await db
    .selectFrom("projects as p")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select("p.slug")
    .where("p.id", "=", projectId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!project) throw new ServiceError("Not found", "NOT_FOUND", 404)

  if (patch.slug !== undefined && !isValidProjectSlug(patch.slug)) {
    throw new ServiceError(
      "slug must be lowercase alphanumeric and hyphens (max 50 chars)",
      "VALIDATION_ERROR",
      400
    )
  }

  const slugChanging = patch.slug !== undefined && patch.slug !== project.slug

  if (slugChanging) {
    // Block rename if any app still has an active (non-stopped) deployment.
    const countResult = await sql<{ count: string }>`
      SELECT COUNT(*) as count FROM apps a
      INNER JOIN deployments d ON d.app_id = a.id
        AND d.created_at = (SELECT MAX(created_at) FROM deployments WHERE app_id = a.id)
      WHERE a.project_id = ${projectId} AND d.status != 'stopped'
    `.execute(db)
    const activeCount = Number(countResult.rows[0]?.count ?? 0)
    if (activeCount > 0) {
      throw new ServiceError(
        "Stop all apps before renaming the project",
        "CONFLICT",
        409
      )
    }
  }

  const updates: Updateable<Database["projects"]> = {}
  if (patch.name !== undefined)        updates.name = patch.name.trim()
  if (patch.description !== undefined) updates.description = patch.description
  if (patch.slug !== undefined)        updates.slug = patch.slug
  if (!Object.keys(updates).length) throw new ServiceError("Nothing to update", "VALIDATION_ERROR", 400)
  updates.updated_at = new Date().toISOString()

  try {
    await db
      .updateTable("projects")
      .set(updates)
      .where("id", "=", projectId)
      .execute()
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new ServiceError("A project with that slug already exists", "CONFLICT", 409)
    }
    throw err
  }

  if (slugChanging) {
    const oldNamespace = appNamespace(projectId, project.slug)
    await db
      .updateTable("deployments")
      .set({ applied_manifest: null })
      .where("status", "=", "stopped")
      .where(
        "app_id",
        "in",
        db.selectFrom("apps").select("id").where("project_id", "=", projectId)
      )
      .execute()

    await db
      .insertInto("pending_namespace_deletions")
      .values({ id: crypto.randomUUID(), namespace: oldNamespace, created_at: new Date().toISOString() })
      .onConflict((oc) => oc.doNothing())
      .execute()
  }

  const row = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow()
  return mapProject(row)
}

export async function deleteProject(
  db: DB,
  projectId: string,
  userId: string
): Promise<void> {
  const project = await db
    .selectFrom("projects as p")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select("p.id")
    .where("p.id", "=", projectId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!project) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const result = await db
    .selectFrom("apps")
    .select(db.fn.countAll<number>().as("count"))
    .where("project_id", "=", projectId)
    .executeTakeFirstOrThrow()
  const appCount = Number(result.count)
  if (appCount > 0) {
    throw new ServiceError(
      `Remove all apps before deleting the project (${appCount} remaining)`,
      "CONFLICT",
      409
    )
  }

  await db
    .deleteFrom("projects")
    .where("id", "=", projectId)
    .execute()
}
