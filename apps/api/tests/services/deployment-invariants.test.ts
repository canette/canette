import { beforeAll, describe, it, expect } from "vitest"
import { copyFileSync, mkdtempSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { ServiceError } from "../../src/services/errors"
import { createApp } from "../../src/services/apps"
import { createDeployment, redeployDeployment } from "../../src/services/deployments"
import { forceSyncLiveApps } from "../../src/services/admin"

const migrationsDir = join(import.meta.dir, "../../migrations")

async function seed(db: ReturnType<typeof createTestDb>) {
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

async function addDeployment(
  db: ReturnType<typeof createTestDb>, appId: string, status: string,
  opts: { id?: string; createdAt?: string; imageDigest?: string } = {},
) {
  const id = opts.id ?? crypto.randomUUID()
  const ts = opts.createdAt ?? new Date().toISOString()
  await db.insertInto("deployments").values({
    id, app_id: appId, status, commit_sha: "abc1234", image_digest: opts.imageDigest ?? null,
    triggered_by: "userId", created_at: ts, updated_at: ts,
  }).execute()
  return id
}

describe("one in-progress deployment per app", () => {
  const db = createTestDb()

  beforeAll(async () => {
    await runMigrations(db, migrationsDir)
    await seed(db)
  })

  async function makeApp(slug: string) {
    return createApp(db, "projId", "userId", {
      name: slug, slug, sourceType: "git", gitUrl: "https://github.com/example/repo",
    })
  }

  async function activeCount(appId: string) {
    const rows = await db.selectFrom("deployments").select("id")
      .where("app_id", "=", appId)
      .where("status", "in", ["pending_build", "building", "scanning", "pending_deployment", "deploying"])
      .execute()
    return rows.length
  }

  function expectOneWinner(results: PromiseSettledResult<unknown>[]) {
    const rejected = results.filter((r) => r.status === "rejected")
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const err = (rejected[0] as PromiseRejectedResult).reason
    expect(err).toBeInstanceOf(ServiceError)
    expect(err).toMatchObject({ code: "DEPLOYMENT_IN_PROGRESS", status: 409 })
  }

  it("two simultaneous deploy requests create one deployment, the other gets 409", async () => {
    const app = await makeApp("double-deploy")
    const results = await Promise.allSettled([
      createDeployment(db, app.id, "userId"),
      createDeployment(db, app.id, "userId"),
    ])
    expectOneWinner(results)
    expect(await activeCount(app.id)).toBe(1)
  })

  it("two simultaneous redeploys create one deployment, the other gets 409", async () => {
    const app = await makeApp("double-redeploy")
    const live = await addDeployment(db, app.id, "live", { imageDigest: "registry/app@sha256:abc" })
    const results = await Promise.allSettled([
      redeployDeployment(db, live, "userId"),
      redeployDeployment(db, live, "userId"),
    ])
    expectOneWinner(results)
    expect(await activeCount(app.id)).toBe(1)
  })

  it("the database rejects a second in-progress row for an app", async () => {
    const app = await makeApp("index-check")
    await addDeployment(db, app.id, "building")
    await expect(addDeployment(db, app.id, "pending_deployment")).rejects.toThrow()
    // Finished rows are not limited.
    await addDeployment(db, app.id, "failed")
    await addDeployment(db, app.id, "live")
  })

  it("force sync skips an app that still has a deployment in progress", async () => {
    const synced = await makeApp("sync-ok")
    const syncedLive = await addDeployment(db, synced.id, "live")
    const stuck = await makeApp("sync-stuck")
    await addDeployment(db, stuck.id, "building", { createdAt: "2026-01-01T00:00:00.000Z" })
    const stuckLive = await addDeployment(db, stuck.id, "live", { createdAt: "2026-01-02T00:00:00.000Z" })

    await forceSyncLiveApps(db)

    const status = async (id: string) =>
      (await db.selectFrom("deployments").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status
    expect(await status(syncedLive)).toBe("pending_deployment")
    expect(await status(stuckLive)).toBe("live")
  })
})

describe("migration 000024", () => {
  it("fails all but the newest in-progress deployment of an app before adding the index", async () => {
    const db = createTestDb()
    const dir = mkdtempSync(join(tmpdir(), "canette-migrations-"))
    const files = readdirSync(migrationsDir)
    const copy = (pred: (f: string) => boolean) =>
      files.filter(pred).forEach((f) => copyFileSync(join(migrationsDir, f), join(dir, f)))

    copy((f) => f < "000024")
    await runMigrations(db, dir)
    await seed(db)
    const now = new Date().toISOString()
    for (const id of ["app-dup", "app-single"]) {
      await db.insertInto("apps").values({
        id, project_id: "projId", name: id, slug: id, source_type: "git", deployment_type: "web",
        git_url: "https://github.com/example/repo", git_branch: "main", git_credential_id: null,
        app_path: "", image_url: "", image_tag: "", port: 3000, password_gate_enabled: false,
        live_url: null, canette_config: null, position: 0,
        runtime_health: "unknown", runtime_health_reason: null, runtime_health_updated_at: null,
        created_at: now, updated_at: now,
      }).execute()
    }
    await addDeployment(db, "app-dup", "building", { id: "oldest", createdAt: "2026-01-01T00:00:00.000Z" })
    await addDeployment(db, "app-dup", "deploying", { id: "older", createdAt: "2026-01-02T00:00:00.000Z" })
    await addDeployment(db, "app-dup", "pending_build", { id: "newest", createdAt: "2026-01-03T00:00:00.000Z" })
    await addDeployment(db, "app-dup", "live", { id: "live", createdAt: "2025-12-31T00:00:00.000Z" })
    await addDeployment(db, "app-single", "building", { id: "single" })

    copy((f) => f.startsWith("000024"))
    await runMigrations(db, dir)

    const rows = await db.selectFrom("deployments").select(["id", "status", "error_message"]).execute()
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId.oldest.status).toBe("failed")
    expect(byId.oldest.error_message).toContain("Superseded")
    expect(byId.older.status).toBe("failed")
    expect(byId.newest.status).toBe("pending_build")
    expect(byId.live.status).toBe("live")
    expect(byId.single.status).toBe("building")
    await expect(addDeployment(db, "app-single", "pending_deployment")).rejects.toThrow()
  })
})
