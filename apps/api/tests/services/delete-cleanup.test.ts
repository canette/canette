import { beforeAll, describe, it, expect } from "vitest"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { ServiceError } from "../../src/services/errors"
import { createApp, deleteApp } from "../../src/services/apps"
import { createDeployment, stopApp } from "../../src/services/deployments"
import { createProject, deleteProject } from "../../src/services/projects"
import { deleteTeam } from "../../src/services/teams"

// Deleting an app or project must leave the controller a way to remove the
// K8s resources, even though the delete cascades the deployment rows.
const db = createTestDb()

describe("delete cleanup", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))

    const now = new Date().toISOString()
    await db.insertInto("user").values({
      id: "userId", name: "Test User", email: "test@example.com",
      emailVerified: false, image: null, role: "developer",
      createdAt: now, updatedAt: now,
    }).execute()
    for (const team of [
      { id: "teamId", is_personal: true },
      { id: "sharedTeam", is_personal: false },
    ]) {
      await db.insertInto("teams").values({
        id: team.id, name: team.id, is_personal: team.is_personal, owner_id: "userId",
        created_at: now, updated_at: now,
      }).execute()
      await db.insertInto("team_members").values({
        id: `member-${team.id}`, team_id: team.id, user_id: "userId", created_at: now,
      }).execute()
    }
    await db.insertInto("projects").values({
      id: "projId", team_id: "teamId", name: "Test Project", slug: "test-project",
      description: null, created_by: "userId", created_at: now, updated_at: now,
    }).execute()
  })

  async function makeApp(slug: string) {
    return createApp(db, "projId", "userId", {
      name: slug, slug, sourceType: "git", gitUrl: "https://github.com/example/repo",
    })
  }

  let deploymentSeq = 0
  async function addDeployment(
    appId: string, status: string,
    opts: { appliedManifest?: string; createdAt?: string; errorMessage?: string } = {},
  ) {
    const ts = opts.createdAt ?? new Date(Date.now() + deploymentSeq * 1000).toISOString()
    deploymentSeq++
    const id = crypto.randomUUID()
    await db.insertInto("deployments").values({
      id, app_id: appId, status, commit_sha: "abc1234",
      commit_message: null, image_digest: null, triggered_by: "userId", error_message: opts.errorMessage ?? null,
      scan_status: null, scan_summary: null, applied_manifest: opts.appliedManifest ?? null,
      canette_config: null, deployment_snapshot: null, created_at: ts, updated_at: ts,
    }).execute()
    return id
  }

  async function cleanupsFor(appSlug: string) {
    return db.selectFrom("queued_app_cleanups").selectAll()
      .where("project_id", "=", "projId").where("app_slug", "=", appSlug).execute()
  }

  describe("deleteApp", () => {
    // What a deploy records: the app should run deploymentId.
    async function setRunning(appId: string, deploymentId: string) {
      await db.updateTable("app_intents")
        .set({ desired_state: "running", target_deployment_id: deploymentId, generation: 1 })
        .where("app_id", "=", appId).execute()
    }

    it("rejects deletion while the app should be running, even if its newest deployment failed", async () => {
      const app = await makeApp("older-live")
      await addDeployment(app.id, "live", { createdAt: "2026-01-01T00:00:00.000Z" })
      const failed = await addDeployment(app.id, "failed", { createdAt: "2026-01-02T00:00:00.000Z" })
      await setRunning(app.id, failed)

      const err = await deleteApp(db, app.id, "userId").catch((e) => e)
      expect(err).toBeInstanceOf(ServiceError)
      expect((err as ServiceError).status).toBe(409)
      expect(await cleanupsFor("older-live")).toHaveLength(0)
    })

    it.each(["pending_build", "building", "scanning", "pending_deployment", "deploying"])(
      "rejects deletion while a deployment is %s",
      async (status) => {
        const slug = `in-flight-${status.replace("_", "-")}`
        const app = await makeApp(slug)
        await setRunning(app.id, await addDeployment(app.id, status))
        await expect(deleteApp(db, app.id, "userId")).rejects.toBeInstanceOf(ServiceError)
      }
    )

    it("allows deleting a stopped app whose build is still being cancelled", async () => {
      const app = await makeApp("stopped-mid-build")
      await setRunning(app.id, await addDeployment(app.id, "building"))
      await stopApp(db, app.id, "userId")
      expect(await deleteApp(db, app.id, "userId")).toBe(true)
      expect(await cleanupsFor("stopped-mid-build")).toHaveLength(1)
    })

    it("queues a cleanup when the app is deleted right after Stop", async () => {
      const app = await makeApp("stop-then-delete")
      await addDeployment(app.id, "live", { appliedManifest: "{}" })
      await stopApp(db, app.id, "userId")

      // Teardown has not run yet: the stopped row still has its manifest.
      expect(await deleteApp(db, app.id, "userId")).toBe(true)

      const rows = await cleanupsFor("stop-then-delete")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ project_id: "projId", project_slug: "test-project", app_slug: "stop-then-delete" })
    })

    it("queues a cleanup for an app with volumes and no deployments", async () => {
      const app = await makeApp("with-pvc")
      const now = new Date().toISOString()
      await db.insertInto("app_volumes").values({
        id: crypto.randomUUID(), app_id: app.id, name: "data", type: "pvc", mount_path: "/data",
        config: JSON.stringify({ size: "1Gi" }), created_at: now, updated_at: now,
      }).execute()

      expect(await deleteApp(db, app.id, "userId")).toBe(true)
      expect(await cleanupsFor("with-pvc")).toHaveLength(1)
    })

    it("blocks reusing the slug until the cleanup has run", async () => {
      const app = await makeApp("reused-slug")
      await deleteApp(db, app.id, "userId")

      const err = await makeApp("reused-slug").catch((e) => e)
      expect(err).toBeInstanceOf(ServiceError)
      expect((err as ServiceError).code).toBe("CONFLICT")

      // The controller deletes the row once the K8s resources are gone.
      await db.deleteFrom("queued_app_cleanups").where("app_slug", "=", "reused-slug").execute()
      const again = await makeApp("reused-slug")
      expect(again.slug).toBe("reused-slug")
    })
  })

  describe("stopApp", () => {
    async function deployment(id: string) {
      return db.selectFrom("deployments")
        .select(["status", "error_message", "applied_manifest", "teardown_requested_at"])
        .where("id", "=", id).executeTakeFirstOrThrow()
    }

    it("marks a first deploy that failed after apply for teardown, keeping its failure", async () => {
      const app = await makeApp("failed-first")
      const id = await addDeployment(app.id, "failed", { appliedManifest: "{}", errorMessage: "CrashLoopBackOff" })

      expect(await stopApp(db, app.id, "userId")).toBe(true)

      const row = await deployment(id)
      expect(row).toMatchObject({ status: "failed", error_message: "CrashLoopBackOff", applied_manifest: "{}" })
      expect(row.teardown_requested_at).not.toBeNull()
    })

    it("only marks the latest attempt that applied resources", async () => {
      const app = await makeApp("failed-twice")
      const older = await addDeployment(app.id, "failed", { appliedManifest: "{}" })
      const latest = await addDeployment(app.id, "failed", { appliedManifest: "{}" })
      // Failed before apply: nothing of it runs in the cluster.
      const unapplied = await addDeployment(app.id, "failed")

      await stopApp(db, app.id, "userId")

      expect((await deployment(older)).teardown_requested_at).toBeNull()
      expect((await deployment(latest)).teardown_requested_at).not.toBeNull()
      expect((await deployment(unapplied)).teardown_requested_at).toBeNull()
    })

    it("marks a failed redeploy too when an older deployment is live", async () => {
      const app = await makeApp("failed-redeploy")
      const live = await addDeployment(app.id, "live", { appliedManifest: "{}" })
      const failed = await addDeployment(app.id, "failed", { appliedManifest: "{}" })

      await stopApp(db, app.id, "userId")

      // The stopped row's teardown removes the same resource names.
      expect((await deployment(live)).status).toBe("stopped")
      expect((await deployment(failed)).teardown_requested_at).not.toBeNull()
    })

    it("does not mark a failed attempt older than the live deployment", async () => {
      const app = await makeApp("failed-then-live")
      const failed = await addDeployment(app.id, "failed", { appliedManifest: "{}" })
      const live = await addDeployment(app.id, "live", { appliedManifest: "{}" })

      await stopApp(db, app.id, "userId")

      expect((await deployment(live)).status).toBe("stopped")
      expect((await deployment(failed)).teardown_requested_at).toBeNull()
    })

    it("a new deployment cancels the pending teardown", async () => {
      const app = await makeApp("failed-then-deploy")
      const failed = await addDeployment(app.id, "failed", { appliedManifest: "{}" })
      await stopApp(db, app.id, "userId")

      await createDeployment(db, app.id, "userId", { commitSha: "def5678" })

      expect(await deployment(failed)).toMatchObject({ status: "failed", applied_manifest: "{}", teardown_requested_at: null })
    })
  })

  describe("deleteProject", () => {
    it("queues the project's namespace for cleanup", async () => {
      const project = await createProject(db, "userId", { name: "Doomed", slug: "doomed", teamId: "teamId" })
      await deleteProject(db, project.id, "userId")

      const rows = await db.selectFrom("queued_namespace_cleanups").selectAll()
        .where("project_id", "=", project.id).execute()
      expect(rows).toHaveLength(1)
      expect(rows[0].project_slug).toBe("doomed")
    })

    it("still refuses to delete a project with apps", async () => {
      const project = await createProject(db, "userId", { name: "Busy", slug: "busy", teamId: "teamId" })
      await createApp(db, project.id, "userId", {
        name: "app", slug: "app", sourceType: "git", gitUrl: "https://github.com/example/repo",
      })
      await expect(deleteProject(db, project.id, "userId")).rejects.toBeInstanceOf(ServiceError)
      const rows = await db.selectFrom("queued_namespace_cleanups").select("id")
        .where("project_id", "=", project.id).execute()
      expect(rows).toHaveLength(0)
    })
  })

  describe("deleteTeam", () => {
    it("queues every project's namespace for cleanup", async () => {
      const a = await createProject(db, "userId", { name: "Team A", slug: "team-a", teamId: "sharedTeam" })
      const b = await createProject(db, "userId", { name: "Team B", slug: "team-b", teamId: "sharedTeam" })
      await deleteTeam(db, "sharedTeam")

      const rows = await db.selectFrom("queued_namespace_cleanups").select(["project_id", "project_slug"])
        .where("project_id", "in", [a.id, b.id]).orderBy("project_slug").execute()
      expect(rows).toEqual([
        { project_id: a.id, project_slug: "team-a" },
        { project_id: b.id, project_slug: "team-b" },
      ])
    })
  })
})
