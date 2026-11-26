import { beforeAll, describe, it, expect } from "vitest"
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { createApp, getAppById } from "../../src/services/apps"
import { createDeployment, redeployDeployment, stopApp } from "../../src/services/deployments"
import { forceSyncLiveApps } from "../../src/services/admin"

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

async function addDeployment(
  db: TestDb, appId: string, status: string,
  opts: { id?: string; createdAt?: string; imageDigest?: string; appliedManifest?: string } = {},
) {
  const id = opts.id ?? crypto.randomUUID()
  const ts = opts.createdAt ?? new Date().toISOString()
  await db.insertInto("deployments").values({
    id, app_id: appId, status, commit_sha: "abc1234", image_digest: opts.imageDigest ?? null,
    applied_manifest: opts.appliedManifest ?? null,
    triggered_by: "userId", created_at: ts, updated_at: ts,
  }).execute()
  return id
}

async function intent(db: TestDb, appId: string) {
  const row = await db.selectFrom("app_intents").selectAll().where("app_id", "=", appId).executeTakeFirst()
  return row && { ...row, generation: Number(row.generation) }
}

describe("app intent", () => {
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

  it("a new app is stopped at generation 0", async () => {
    const app = await makeApp("new-app")
    expect(await intent(db, app.id)).toMatchObject({
      desired_state: "stopped", generation: 0, target_deployment_id: null,
    })
  })

  it("deploy, stop and redeploy each bump the generation and record the target", async () => {
    const app = await makeApp("lifecycle")

    const first = await createDeployment(db, app.id, "userId")
    expect(await intent(db, app.id)).toMatchObject({
      desired_state: "running", generation: 1, target_deployment_id: first.id, updated_by: "userId",
    })

    // Let it go live with an image, as the builder and controller would.
    await db.updateTable("deployments").set({ status: "live", image_digest: "registry/app@sha256:abc" })
      .where("id", "=", first.id).execute()

    expect(await stopApp(db, app.id, "userId")).toBe(true)
    // Stop keeps the target: it still names what to bring back.
    expect(await intent(db, app.id)).toMatchObject({
      desired_state: "stopped", generation: 2, target_deployment_id: first.id,
    })

    const again = await redeployDeployment(db, first.id, "userId")
    expect(await intent(db, app.id)).toMatchObject({
      desired_state: "running", generation: 3, target_deployment_id: again!.id,
    })
  })

  it("the app's lifecycleStatus follows its intent, not its newest deployment", async () => {
    const app = await makeApp("status")
    expect((await getAppById(db, app.id, "userId"))?.lifecycleStatus).toBeUndefined()
    const dep = await createDeployment(db, app.id, "userId")
    expect((await getAppById(db, app.id, "userId"))?.lifecycleStatus).toBe("building")
    await stopApp(db, app.id, "userId")
    // Stopped while it builds: the build is still the newest deployment.
    const stopping = await getAppById(db, app.id, "userId")
    expect(stopping?.latestDeploymentStatus).toBe("pending_build")
    expect(stopping?.lifecycleStatus).toBe("stopping")
    expect(dep.id).toBeTruthy()
  })

  it("an app reports the controller's last error while it should run", async () => {
    const app = await makeApp("repair-failed")
    const live = await addDeployment(db, app.id, "live")
    await db.updateTable("app_intents").set({ desired_state: "running", target_deployment_id: live, generation: 2 })
      .where("app_id", "=", app.id).execute()
    // A re-sync whose rollout failed: reconciled, the target still live.
    await db.insertInto("app_runtime").values({
      app_id: app.id, reconciled_generation: 2, applied_deployment_id: live, live_url: "https://x",
      last_error: "rollout failed: pods crash",
    }).execute()

    const got = await getAppById(db, app.id, "userId")
    expect(got?.lifecycleStatus).toBe("live")
    expect(got?.lifecycleError).toBe("rollout failed: pods crash")

    await stopApp(db, app.id, "userId")
    expect((await getAppById(db, app.id, "userId"))?.lifecycleError).toBeUndefined()
  })

  it("a webhook deploy records no user", async () => {
    const app = await makeApp("webhook-deploy")
    const dep = await createDeployment(db, app.id, null, { commitSha: "deadbeef" })
    expect(await intent(db, app.id)).toMatchObject({ target_deployment_id: dep.id, updated_by: null })
  })

  it("a webhook deploy re-checks under the lock that the app is running", async () => {
    // The webhook's early check saw it running, then a Stop committed.
    const app = await makeApp("stopped-meanwhile")
    await createDeployment(db, app.id, "userId")
    await db.updateTable("deployments").set({ status: "live" }).where("app_id", "=", app.id).execute()
    await stopApp(db, app.id, "userId")
    const before = await intent(db, app.id)

    await expect(createDeployment(db, app.id, null, { commitSha: "deadbeef", onlyIfRunning: true }))
      .rejects.toMatchObject({ code: "APP_NOT_RUNNING" })
    expect(await intent(db, app.id)).toEqual(before)
    const rows = await db.selectFrom("deployments").select("id").where("app_id", "=", app.id).execute()
    expect(rows).toHaveLength(1)

    // A running app is deployed as usual.
    const running = await makeApp("running-push")
    await createDeployment(db, running.id, "userId")
    await db.updateTable("deployments").set({ status: "live" }).where("app_id", "=", running.id).execute()
    const pushed = await createDeployment(db, running.id, null, { commitSha: "deadbeef", onlyIfRunning: true })
    expect(await intent(db, running.id)).toMatchObject({ desired_state: "running", target_deployment_id: pushed.id })
  })

  it("a refused deploy changes neither the intent nor a pending teardown", async () => {
    // A webhook deploy of an app stopped meanwhile is refused inside the
    // transaction, which cancels pending teardowns only when it commits.
    const app = await makeApp("refused")
    const stopped = await addDeployment(db, app.id, "stopped", { appliedManifest: "kind: Deployment" })
    await db.updateTable("app_intents").set({ generation: 1 }).where("app_id", "=", app.id).execute()
    const before = await intent(db, app.id)

    await expect(createDeployment(db, app.id, null, { commitSha: "deadbeef", onlyIfRunning: true }))
      .rejects.toMatchObject({ code: "APP_NOT_RUNNING" })

    expect(await intent(db, app.id)).toEqual(before)
    const row = await db.selectFrom("deployments").select("applied_manifest").where("id", "=", stopped).executeTakeFirstOrThrow()
    expect(row.applied_manifest).toBe("kind: Deployment")
  })

  it("an app without an intent row (created before its row existed) gets one on its first action", async () => {
    const app = await makeApp("no-row")
    await db.deleteFrom("app_intents").where("app_id", "=", app.id).execute()
    const dep = await createDeployment(db, app.id, "userId")
    expect(await intent(db, app.id)).toMatchObject({
      desired_state: "running", generation: 1, target_deployment_id: dep.id,
    })
  })

  it("force sync bumps the intent of an app serving its target", async () => {
    const app = await makeApp("force-sync")
    const live = await addDeployment(db, app.id, "live")
    await db.updateTable("app_intents").set({ desired_state: "running", target_deployment_id: live, generation: 1 })
      .where("app_id", "=", app.id).execute()

    const before = await intent(db, app.id)
    await forceSyncLiveApps(db)

    // Only the generation: updated_at dates the last change of what the app
    // should run, which the controller's adoption of an older API's deploys
    // compares against.
    expect(await intent(db, app.id)).toEqual({ ...before!, generation: 2 })
    const row = await db.selectFrom("deployments").select("status").where("id", "=", live).executeTakeFirstOrThrow()
    expect(row.status).toBe("live") // the history is left alone
  })
})

describe("migration 000027", () => {
  it("gives every app an intent from its latest deployment", async () => {
    const db = createTestDb()
    const dir = mkdtempSync(join(tmpdir(), "canette-migrations-"))
    const files = readdirSync(migrationsDir)
    const copy = (pred: (f: string) => boolean) =>
      files.filter(pred).forEach((f) => copyFileSync(join(migrationsDir, f), join(dir, f)))

    copy((f) => f < "000027")
    await runMigrations(db, dir)
    await seed(db)
    const now = new Date().toISOString()
    for (const id of ["never", "running", "stopped"]) {
      await db.insertInto("apps").values({
        id, project_id: "projId", name: id, slug: id, source_type: "git", deployment_type: "web",
        git_url: "https://github.com/example/repo", git_branch: "main", git_credential_id: null,
        app_path: "", image_url: "", image_tag: "", port: 3000, password_gate_enabled: false,
        live_url: null, canette_config: null, position: 0,
        created_at: now, updated_at: now,
      }).execute()
    }
    await addDeployment(db, "running", "failed", { id: "run-old", createdAt: "2026-01-01T00:00:00.000Z" })
    await addDeployment(db, "running", "live", { id: "run-live", createdAt: "2026-01-02T00:00:00.000Z" })
    await addDeployment(db, "stopped", "live", { id: "stop-old", createdAt: "2026-01-01T00:00:00.000Z" })
    await addDeployment(db, "stopped", "stopped", { id: "stop-new", createdAt: "2026-01-02T00:00:00.000Z" })

    copy((f) => f.startsWith("000027"))
    await runMigrations(db, dir)

    expect(await intent(db, "never")).toMatchObject({ desired_state: "stopped", generation: 0, target_deployment_id: null })
    expect(await intent(db, "running")).toMatchObject({ desired_state: "running", generation: 1, target_deployment_id: "run-live" })
    expect(await intent(db, "stopped")).toMatchObject({ desired_state: "stopped", generation: 1, target_deployment_id: "stop-new" })

    // The SQLite rebuild keeps the rows and the one-in-progress index, and
    // allows superseded.
    expect(await db.selectFrom("deployments").select("id").execute()).toHaveLength(4)
    await addDeployment(db, "running", "superseded")
    await addDeployment(db, "running", "building")
    await expect(addDeployment(db, "running", "pending_deployment")).rejects.toThrow()
    await expect(addDeployment(db, "running", "bogus")).rejects.toThrow()
  })
})

describe("runMigrations on SQLite", () => {
  it("runs a migration's .up.sqlite.sql in place of its .up.sql", async () => {
    const db = createTestDb()
    const dir = mkdtempSync(join(tmpdir(), "canette-migrations-"))
    writeFileSync(join(dir, "000001_t.up.sql"), "CREATE TABLE from_postgres_file (id TEXT)")
    writeFileSync(join(dir, "000001_t.up.sqlite.sql"), "CREATE TABLE from_sqlite_file (id TEXT)")
    writeFileSync(join(dir, "000002_u.up.sql"), "CREATE TABLE shared (id TEXT)")

    await runMigrations(db, dir)

    const tables = await db.introspection.getTables()
    const names = tables.map((t) => t.name)
    expect(names).toContain("from_sqlite_file")
    expect(names).toContain("shared")
    expect(names).not.toContain("from_postgres_file")
    const versions = await db.selectFrom("schema_migrations").select("version").orderBy("version").execute()
    expect(versions.map((v) => v.version)).toEqual(["000001_t", "000002_u"])
  })
})

describe("runMigrations", () => {
  it("rolls back a migration that fails part way, so a retry runs it again", async () => {
    const db = createTestDb()
    const dir = mkdtempSync(join(tmpdir(), "canette-migrations-"))
    const migration = join(dir, "000001_t.up.sql")
    writeFileSync(migration, "CREATE TABLE first_step (id TEXT);\nINSERT INTO missing_table VALUES (1)")

    await expect(runMigrations(db, dir)).rejects.toThrow()
    const names = (await db.introspection.getTables()).map((t) => t.name)
    expect(names).not.toContain("first_step")
    expect(await db.selectFrom("schema_migrations").select("version").execute()).toHaveLength(0)

    writeFileSync(migration, "CREATE TABLE first_step (id TEXT)")
    await runMigrations(db, dir)
    expect((await db.introspection.getTables()).map((t) => t.name)).toContain("first_step")
  })
})
