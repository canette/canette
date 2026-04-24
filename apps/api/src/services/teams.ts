import type { DB } from "../db/db"
import type { AdminTeamOverview, Team, TeamMember, User } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db/types"
import { ServiceError } from "./errors"

// ── Internal row types ────────────────────────────────────────────────────────

type TeamRow = Selectable<Database["teams"]>
type TeamMemberRow = Selectable<Database["team_members"]>
type UserRow = Pick<Selectable<Database["user"]>, "id" | "name" | "email" | "image">

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapTeam(row: TeamRow & { member_count?: number | string | null }): Team {
  return {
    id: row.id,
    name: row.name,
    isPersonal: row.is_personal,
    ownerId: row.owner_id,
    memberCount: Number(row.member_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapTeamMember(row: { user_id: string; created_at: string; name: string; email: string; image: string | null }): TeamMember {
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    image: row.image ?? undefined,
    joinedAt: row.created_at,
  }
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function listTeams(db: DB, userId: string): Promise<Team[]> {
  const rows = await db
    .selectFrom("teams as t")
    .innerJoin("team_members as tm", "tm.team_id", "t.id")
    .select([
      "t.id",
      "t.name",
      "t.is_personal",
      "t.owner_id",
      "t.created_at",
      "t.updated_at",
    ])
    .select((eb) =>
      eb
        .selectFrom("team_members")
        .select(eb.fn.countAll<number>().as("c"))
        .whereRef("team_id", "=", "t.id")
        .as("member_count")
    )
    .where("tm.user_id", "=", userId)
    .orderBy("t.created_at", "asc")
    .execute()
  return rows.map(mapTeam)
}

export async function getTeam(db: DB, teamId: string, userId: string): Promise<Team | null> {
  const row = await db
    .selectFrom("teams as t")
    .innerJoin("team_members as tm", "tm.team_id", "t.id")
    .select([
      "t.id",
      "t.name",
      "t.is_personal",
      "t.owner_id",
      "t.created_at",
      "t.updated_at",
    ])
    .select((eb) =>
      eb
        .selectFrom("team_members")
        .select(eb.fn.countAll<number>().as("c"))
        .whereRef("team_id", "=", "t.id")
        .as("member_count")
    )
    .where("t.id", "=", teamId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  return row ? mapTeam(row) : null
}

export async function getTeamMembers(
  db: DB,
  teamId: string,
  userId: string
): Promise<TeamMember[] | null> {
  // Verify access
  const membership = await db
    .selectFrom("team_members")
    .select("id")
    .where("team_id", "=", teamId)
    .where("user_id", "=", userId)
    .executeTakeFirst()
  if (!membership) return null

  const rows = await db
    .selectFrom("team_members as tm")
    .innerJoin("user as u", "u.id", "tm.user_id")
    .select(["tm.user_id", "tm.created_at", "u.name", "u.email", "u.image"])
    .where("tm.team_id", "=", teamId)
    .orderBy("tm.created_at", "asc")
    .execute()
  return rows.map(mapTeamMember)
}

export async function createTeam(
  db: DB,
  requesterId: string,
  requesterRole: string,
  input: { name: string }
): Promise<Team> {
  if (requesterRole !== "admin") {
    throw new ServiceError("Only admins can create teams", "FORBIDDEN", 403)
  }
  if (!input.name?.trim()) {
    throw new ServiceError("name is required", "VALIDATION_ERROR", 400)
  }

  const teamId = crypto.randomUUID()
  const now = new Date().toISOString()

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("teams")
      .values({
        id: teamId,
        name: input.name.trim(),
        is_personal: false,
        owner_id: requesterId,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await trx
      .insertInto("team_members")
      .values({
        id: crypto.randomUUID(),
        team_id: teamId,
        user_id: requesterId,
        created_at: now,
      })
      .execute()
  })

  const row = await db
    .selectFrom("teams")
    .selectAll()
    .where("id", "=", teamId)
    .executeTakeFirstOrThrow()
  return mapTeam({ ...row, member_count: 1 })
}

export async function renameTeam(
  db: DB,
  teamId: string,
  name: string,
  requesterId: string,
  requesterRole: string
): Promise<Team> {
  if (requesterRole !== "admin") {
    throw new ServiceError("Only admins can rename teams", "FORBIDDEN", 403)
  }
  if (!name?.trim()) {
    throw new ServiceError("name is required", "VALIDATION_ERROR", 400)
  }

  const team = await db
    .selectFrom("teams")
    .selectAll()
    .where("id", "=", teamId)
    .executeTakeFirst()
  if (!team) throw new ServiceError("Not found", "NOT_FOUND", 404)
  if (team.is_personal) {
    throw new ServiceError("Personal teams cannot be renamed", "FORBIDDEN", 403)
  }

  await db
    .updateTable("teams")
    .set({ name: name.trim(), updated_at: new Date().toISOString() })
    .where("id", "=", teamId)
    .execute()

  return (await getTeam(db, teamId, requesterId))!
}

export async function deleteTeam(
  db: DB,
  teamId: string,
  requesterId: string,
  requesterRole: string
): Promise<void> {
  if (requesterRole !== "admin") {
    throw new ServiceError("Only admins can delete teams", "FORBIDDEN", 403)
  }

  const team = await db
    .selectFrom("teams")
    .selectAll()
    .where("id", "=", teamId)
    .executeTakeFirst()
  if (!team) throw new ServiceError("Not found", "NOT_FOUND", 404)
  if (team.is_personal) {
    throw new ServiceError("Personal teams cannot be deleted", "FORBIDDEN", 403)
  }

  const projectCount = await db
    .selectFrom("projects")
    .select(db.fn.countAll<number>().as("count"))
    .where("team_id", "=", teamId)
    .executeTakeFirstOrThrow()
  if (Number(projectCount.count) > 0) {
    throw new ServiceError(
      "Remove all projects from the team before deleting it",
      "CONFLICT",
      409
    )
  }

  await db.deleteFrom("teams").where("id", "=", teamId).execute()
}

export async function addMember(
  db: DB,
  teamId: string,
  targetUserId: string,
  requesterId: string,
  requesterRole: string
): Promise<void> {
  if (requesterRole !== "admin") {
    throw new ServiceError("Only admins can add team members", "FORBIDDEN", 403)
  }

  const team = await db
    .selectFrom("teams")
    .select("id")
    .where("id", "=", teamId)
    .executeTakeFirst()
  if (!team) throw new ServiceError("Team not found", "NOT_FOUND", 404)

  const target = await db
    .selectFrom("user")
    .select("id")
    .where("id", "=", targetUserId)
    .executeTakeFirst()
  if (!target) throw new ServiceError("User not found", "NOT_FOUND", 404)

  try {
    await db
      .insertInto("team_members")
      .values({
        id: crypto.randomUUID(),
        team_id: teamId,
        user_id: targetUserId,
        created_at: new Date().toISOString(),
      })
      .execute()
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      // Already a member — idempotent, no error
      return
    }
    throw err
  }
}

export async function removeMember(
  db: DB,
  teamId: string,
  targetUserId: string,
  requesterId: string,
  requesterRole: string
): Promise<void> {
  if (requesterRole !== "admin") {
    throw new ServiceError("Only admins can remove team members", "FORBIDDEN", 403)
  }

  const team = await db
    .selectFrom("teams")
    .select(["id", "owner_id", "is_personal"])
    .where("id", "=", teamId)
    .executeTakeFirst()
  if (!team) throw new ServiceError("Team not found", "NOT_FOUND", 404)

  if (team.owner_id === targetUserId) {
    throw new ServiceError("Cannot remove the team owner", "CONFLICT", 409)
  }

  await db
    .deleteFrom("team_members")
    .where("team_id", "=", teamId)
    .where("user_id", "=", targetUserId)
    .execute()
}

// ── Admin overview ────────────────────────────────────────────────────────────

export async function listTeamsOverview(db: DB): Promise<AdminTeamOverview[]> {
  const rows = await db
    .selectFrom("teams as t")
    .select([
      "t.id",
      "t.name",
      "t.is_personal",
      "t.created_at",
    ])
    .select((eb) =>
      eb
        .selectFrom("team_members")
        .select(eb.fn.countAll<number>().as("c"))
        .whereRef("team_id", "=", "t.id")
        .as("member_count")
    )
    .select((eb) =>
      eb
        .selectFrom("projects")
        .select(eb.fn.countAll<number>().as("c"))
        .whereRef("team_id", "=", "t.id")
        .as("project_count")
    )
    .orderBy("t.created_at", "asc")
    .execute()

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isPersonal: r.is_personal,
    memberCount: Number(r.member_count ?? 0),
    projectCount: Number(r.project_count ?? 0),
    createdAt: r.created_at,
  }))
}

// ── User lookup for adding members ───────────────────────────────────────────

export async function findUserByEmail(
  db: DB,
  email: string
): Promise<Pick<User, "id" | "name" | "email"> | null> {
  const row = await db
    .selectFrom("user")
    .select(["id", "name", "email"])
    .where("email", "=", email.toLowerCase().trim())
    .executeTakeFirst()
  return row ?? null
}
