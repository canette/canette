import type { DB } from "../db/db"
import type { PaginatedResponse, Project } from "@canette/types"
import type { Selectable, Updateable } from "kysely"
import type { Database } from "../db/types"
import { sql } from "kysely"
import { ServiceError } from "./errors"
import { lockIntents } from "./intents"
import { isTeamMember } from "./membership"
import { isUniqueConstraintError } from "../db/errors"

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
    if (isUniqueConstraintError(err)) {
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
  patch: { name?: string; description?: string | null; slug?: string }
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

  if (patch.name !== undefined && !patch.name.trim()) {
    throw new ServiceError("name is required", "VALIDATION_ERROR", 400)
  }

  if (patch.slug !== undefined && !isValidProjectSlug(patch.slug)) {
    throw new ServiceError(
      "slug must be lowercase alphanumeric and hyphens (max 50 chars)",
      "VALIDATION_ERROR",
      400
    )
  }

  const newSlug = patch.slug !== undefined && patch.slug !== project.slug ? patch.slug : null
  const slugChanging = newSlug !== null

  if (slugChanging) {
    // Whether every app is stopped is checked in the transaction below.
    // A rename deletes the old namespace, and every PVC in it with it. Stop
    // keeps PVCs, so a stopped app would silently come back with an empty
    // volume.
    const pvcResult = await db
      .selectFrom("app_volumes as v")
      .innerJoin("apps as a", "a.id", "v.app_id")
      .select(db.fn.countAll<number>().as("count"))
      .where("a.project_id", "=", projectId)
      .where("v.type", "=", "pvc")
      .executeTakeFirstOrThrow()
    if (Number(pvcResult.count) > 0) {
      throw new ServiceError(
        "Remove the persistent volumes from every app before renaming the project: renaming deletes the volumes and their data",
        "CONFLICT",
        409
      )
    }
  }

  const updates: Updateable<Database["projects"]> = {}
  if (patch.name !== undefined)        updates.name = patch.name.trim()
  // null (or an empty string) clears the description
  if (patch.description !== undefined) updates.description = patch.description || null
  if (patch.slug !== undefined)        updates.slug = patch.slug
  if (!Object.keys(updates).length) throw new ServiceError("Nothing to update", "VALIDATION_ERROR", 400)
  updates.updated_at = new Date().toISOString()

  // One transaction, so an interrupted rename can't leave the old namespace
  // without a queued cleanup (orphaned) or a teardown pointing at it.
  await db.transaction().execute(async (tx) => {
    if (slugChanging) {
      // Every app must be stopped: the rename deletes the old namespace. Its
      // intent says so, checked under the intent locks so that no deploy can
      // be accepted meanwhile. The newest deployment can't tell: deploys can
      // commit in another order than they were created, and a stopped app's
      // newest deployment can be superseded.
      const appIds = (await tx.selectFrom("apps").select("id").where("project_id", "=", projectId).execute())
        .map((r) => r.id)
      await lockIntents(tx, appIds)
      const running = appIds.length === 0 ? undefined : await tx
        .selectFrom("app_intents")
        .select("app_id")
        .where("app_id", "in", appIds)
        .where("desired_state", "=", "running")
        .executeTakeFirst()
      if (running) {
        throw new ServiceError("Stop all apps before renaming the project", "CONFLICT", 409)
      }
    }
    try {
      await tx
        .updateTable("projects")
        .set(updates)
        .where("id", "=", projectId)
        .execute()
    } catch (err: unknown) {
      if (isUniqueConstraintError(err)) {
        throw new ServiceError("A project with that slug already exists", "CONFLICT", 409)
      }
      throw err
    }

    if (!slugChanging) return
    const projectApps = tx.selectFrom("apps").select("id").where("project_id", "=", projectId)
    await tx
      .updateTable("deployments")
      .set({ applied_manifest: null })
      .where("status", "=", "stopped")
      .where("app_id", "in", projectApps)
      .execute()
    await tx
      .updateTable("deployments")
      .set({ teardown_requested_at: null })
      .where("teardown_requested_at", "is not", null)
      .where("app_id", "in", projectApps)
      .execute()

    await tx
      .insertInto("queued_namespace_cleanups")
      .values({ id: crypto.randomUUID(), project_id: projectId, project_slug: project.slug, created_at: new Date().toISOString() })
      .onConflict((oc) => oc.doNothing())
      .execute()

    // Renaming back to a slug whose namespace is still queued makes that
    // namespace the live one again, so it must not be deleted.
    await tx
      .deleteFrom("queued_namespace_cleanups")
      .where("project_id", "=", projectId)
      .where("project_slug", "=", newSlug)
      .execute()
  })

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
    .select(["p.id", "p.slug"])
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

  // The namespace outlives the apps: it still holds the project's policies
  // and anything left behind, so it is deleted together with the project.
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("queued_namespace_cleanups")
      .values({ id: crypto.randomUUID(), project_id: project.id, project_slug: project.slug, created_at: new Date().toISOString() })
      .onConflict((oc) => oc.doNothing())
      .execute()

    await tx
      .deleteFrom("projects")
      .where("id", "=", projectId)
      .execute()
  })
}
