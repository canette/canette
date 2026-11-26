import { beforeAll, describe, it, expect } from "vitest"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { resetStuckBuilds } from "../../src/services/admin"
import { createApp } from "../../src/services/apps"
import { createProject } from "../../src/services/projects"

const db = createTestDb()
let projectId: string

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
    projectId = project.id
  })

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const longAgo = () => ago(60 * 60 * 1000)

  // Each deployment gets an app of its own: an app can have only one
  // deployment in progress.
  async function addDeployment(id: string, status: string, claimedAt: string | null, updatedAt: string) {
    const app = await createApp(db, projectId, "userId", {
      name: id, slug: id, sourceType: "git", gitUrl: "https://github.com/example/repo",
    })
    await db.insertInto("deployments").values({
      id, app_id: app.id, status, commit_sha: "abc", claimed_at: claimedAt,
      created_at: updatedAt, updated_at: updatedAt,
    }).execute()
  }

  async function statusOf(id: string) {
    const row = await db.selectFrom("deployments").select("status").where("id", "=", id).executeTakeFirstOrThrow()
    return row.status
  }

  it("fails building and scanning rows, and leaves the rest", async () => {
    await addDeployment("building", "building", null, ago(1000))
    await addDeployment("scanning", "scanning", null, ago(1000))
    // The controller resumes a deploying row itself, however old.
    await addDeployment("deploying", "deploying", longAgo(), longAgo())
    await addDeployment("pending", "pending_deployment", null, longAgo())
    await addDeployment("live", "live", null, longAgo())

    const result = await resetStuckBuilds(db)
    expect(result.synced).toBe(2)

    for (const id of ["building", "scanning"]) {
      expect(await statusOf(id)).toBe("failed")
    }
    expect(await statusOf("deploying")).toBe("deploying")
    expect(await statusOf("pending")).toBe("pending_deployment")
    expect(await statusOf("live")).toBe("live")

    const again = await resetStuckBuilds(db)
    expect(again.synced).toBe(0)
    expect(again.message).toBe("No stuck deployments found.")
  })
})
