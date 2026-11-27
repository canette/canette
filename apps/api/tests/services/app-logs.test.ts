import { beforeAll, describe, it, expect } from "vitest"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { createApp } from "../../src/services/apps"
import { getAppPodTarget } from "../../src/services/app-logs"

const migrationsDir = join(import.meta.dir, "../../migrations")

type TestDb = ReturnType<typeof createTestDb>

async function seed(db: TestDb) {
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
  await db.insertInto("projects").values({
    id: "projId", team_id: "teamId", name: "Test Project", slug: "test-project",
    description: null, created_by: "userId", created_at: now, updated_at: now,
  }).execute()
}

describe("getAppPodTarget", () => {
  const db = createTestDb()

  beforeAll(async () => {
    await runMigrations(db, migrationsDir)
    await seed(db)
  })

  // An app running deployment `snapshot`, then edited to `current` without a redeploy.
  async function editedApp(slug: string, snapshot: string | null, current: "web" | "cronjob") {
    const app = await createApp(db, "projId", "userId", {
      name: slug, slug, sourceType: "git", gitUrl: "https://github.com/example/repo",
    })
    const now = new Date().toISOString()
    const deploymentId = crypto.randomUUID()
    await db.insertInto("deployments").values({
      id: deploymentId, app_id: app.id, status: "live", commit_sha: "abc1234", image_digest: null,
      deployment_snapshot: snapshot, triggered_by: "userId", created_at: now, updated_at: now,
    }).execute()
    await db.updateTable("app_intents")
      .set({ desired_state: "running", target_deployment_id: deploymentId, generation: 1 })
      .where("app_id", "=", app.id).execute()
    await db.insertInto("app_runtime").values({
      app_id: app.id, reconciled_generation: 1, applied_deployment_id: deploymentId,
    }).execute()
    await db.updateTable("apps").set({ deployment_type: current }).where("id", "=", app.id).execute()
    return app.id
  }

  it("takes the workload type from the deployment that serves, not the app's current type", async () => {
    const appId = await editedApp("edited", JSON.stringify({ app: { deployment_type: "web" } }), "cronjob")
    expect((await getAppPodTarget(db, appId, "userId"))?.deploymentType).toBe("web")
  })

  it("reads a snapshot from before deployment_type existed as web", async () => {
    const appId = await editedApp("old-snapshot", JSON.stringify({ app: {} }), "cronjob")
    expect((await getAppPodTarget(db, appId, "userId"))?.deploymentType).toBe("web")
  })

  it("falls back to the app's type when the snapshot can't be read", async () => {
    const appId = await editedApp("no-snapshot", null, "cronjob")
    expect((await getAppPodTarget(db, appId, "userId"))?.deploymentType).toBe("cronjob")
  })
})
