import { beforeAll, describe, it, expect } from "vitest"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { DEPLOYING_HEARTBEAT_TTL_MS, resetStuckBuilds } from "../../src/services/admin"
import { createApp } from "../../src/services/apps"
import { createProject } from "../../src/services/projects"

const db = createTestDb()
let appId: string

describe("resetStuckBuilds", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))

    const now = new Date().toISOString()
    await db.insertInto("user").values({
      id: "userId", name: "Test User", email: "test@example.com",
      emailVerified: false, image: null, role: "developer",
      createdAt: now, updatedAt: now,
    }).execute()
    await db.insertInto("teams").values({
      id: "teamId", name: "teamId", is_personal: true, owner_id: "userId",
      created_at: now, updated_at: now,
    }).execute()
    await db.insertInto("team_members").values({
      id: "member-teamId", team_id: "teamId", user_id: "userId", created_at: now,
    }).execute()
    const project = await createProject(db, "userId", { name: "p", slug: "p", teamId: "teamId" })
    const app = await createApp(db, project.id, "userId", {
      name: "a", slug: "a", sourceType: "git", gitUrl: "https://github.com/example/repo",
    })
    appId = app.id
  })

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const expired = () => ago(DEPLOYING_HEARTBEAT_TTL_MS + 60_000)

  async function addDeployment(id: string, status: string, claimedAt: string | null, updatedAt: string) {
    await db.insertInto("deployments").values({
      id, app_id: appId, status, commit_sha: "abc", claimed_at: claimedAt,
      created_at: updatedAt, updated_at: updatedAt,
    }).execute()
  }

  async function statusOf(id: string) {
    const row = await db.selectFrom("deployments").select("status").where("id", "=", id).executeTakeFirstOrThrow()
    return row.status
  }

  it("fails building, scanning and abandoned deploying rows, and leaves the rest", async () => {
    await addDeployment("building", "building", null, ago(1000))
    await addDeployment("scanning", "scanning", null, ago(1000))
    await addDeployment("deploying-expired", "deploying", expired(), expired())
    // Claimed before claimed_at existed: falls back to updated_at.
    await addDeployment("deploying-legacy", "deploying", null, expired())
    // Heartbeat is fresh even though the row was claimed long ago.
    await addDeployment("deploying-fresh", "deploying", ago(10_000), expired())
    await addDeployment("pending", "pending_deployment", null, expired())
    await addDeployment("live", "live", null, expired())

    const result = await resetStuckBuilds(db)
    expect(result.synced).toBe(4)

    for (const id of ["building", "scanning", "deploying-expired", "deploying-legacy"]) {
      expect(await statusOf(id)).toBe("failed")
    }
    expect(await statusOf("deploying-fresh")).toBe("deploying")
    expect(await statusOf("pending")).toBe("pending_deployment")
    expect(await statusOf("live")).toBe("live")

    const again = await resetStuckBuilds(db)
    expect(again.synced).toBe(0)
    expect(again.message).toBe("No stuck deployments found.")
  })
})
