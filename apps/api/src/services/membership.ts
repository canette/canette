import type { DB } from "../db/db"

export async function isTeamMember(db: DB, teamId: string, userId: string): Promise<boolean> {
  const row = await db.selectFrom("team_members")
    .select("id")
    .where("team_id", "=", teamId)
    .where("user_id", "=", userId)
    .executeTakeFirst()
  return !!row
}
