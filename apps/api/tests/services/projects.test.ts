import { beforeAll, describe, it, expect } from "vitest"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { ServiceError } from "../../src/services/errors"
import { createApp } from "../../src/services/apps"
import { createProject, updateProject } from "../../src/services/projects"

const db = createTestDb()

describe("updateProject", () => {
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
  })

  async function makeProject(slug: string) {
    return createProject(db, "userId", { name: slug, slug, teamId: "teamId" })
  }

  async function addVolume(appId: string, type: "pvc" | "emptyDir") {
    const now = new Date().toISOString()
    await db.insertInto("app_volumes").values({
      id: crypto.randomUUID(), app_id: appId, name: "data", type, mount_path: "/data",
      config: JSON.stringify(type === "pvc" ? { size: "1Gi" } : {}), created_at: now, updated_at: now,
    }).execute()
  }

  async function queuedSlugs(projectId: string) {
    const rows = await db.selectFrom("queued_namespace_cleanups").select("project_slug")
      .where("project_id", "=", projectId).execute()
    return rows.map((r) => r.project_slug).sort()
  }

  describe("with a PVC volume", () => {
    it("rejects a slug change and queues nothing", async () => {
      const project = await makeProject("has-pvc")
      const app = await createApp(db, project.id, "userId", {
        name: "web", slug: "web", sourceType: "git", gitUrl: "https://github.com/example/repo",
      })
      await addVolume(app.id, "pvc")

      const err = await updateProject(db, project.id, "userId", { slug: "has-pvc-renamed" }).catch((e) => e)
      expect(err).toBeInstanceOf(ServiceError)
      expect((err as ServiceError).status).toBe(409)
      expect((err as ServiceError).message).toContain("persistent volumes")

      const row = await db.selectFrom("projects").select("slug").where("id", "=", project.id).executeTakeFirstOrThrow()
      expect(row.slug).toBe("has-pvc")
      expect(await queuedSlugs(project.id)).toEqual([])
    })

    it("still allows name and description changes", async () => {
      const project = await makeProject("has-pvc-name")
      const app = await createApp(db, project.id, "userId", {
        name: "web", slug: "web", sourceType: "git", gitUrl: "https://github.com/example/repo",
      })
      await addVolume(app.id, "pvc")

      const updated = await updateProject(db, project.id, "userId", {
        name: "Renamed", description: "new", slug: "has-pvc-name",
      })
      expect(updated.name).toBe("Renamed")
      expect(updated.slug).toBe("has-pvc-name")
      expect(await queuedSlugs(project.id)).toEqual([])
    })
  })

  describe("without a PVC volume", () => {
    it("renames and queues the old namespace", async () => {
      const project = await makeProject("no-pvc")
      const app = await createApp(db, project.id, "userId", {
        name: "web", slug: "web", sourceType: "git", gitUrl: "https://github.com/example/repo",
      })
      await addVolume(app.id, "emptyDir")

      const updated = await updateProject(db, project.id, "userId", { slug: "no-pvc-renamed" })
      expect(updated.slug).toBe("no-pvc-renamed")
      expect(await queuedSlugs(project.id)).toEqual(["no-pvc"])
    })

    it("refuses while an app should be running, whatever its newest deployment", async () => {
      // Two deploys committed in the other order than they were created:
      // the intent's target went live, the newer row was superseded.
      const project = await makeProject("serving")
      const app = await createApp(db, project.id, "userId", {
        name: "web", slug: "web", sourceType: "git", gitUrl: "https://github.com/example/repo",
      })
      const at = (s: string) => `2026-01-0${s}T00:00:00.000Z`
      await db.insertInto("deployments").values([
        { id: "target", app_id: app.id, status: "live", commit_sha: "a", created_at: at("1"), updated_at: at("1") },
        { id: "newer", app_id: app.id, status: "superseded", commit_sha: "b", created_at: at("2"), updated_at: at("2") },
      ]).execute()
      await db.updateTable("app_intents").set({ desired_state: "running", target_deployment_id: "target", generation: 2 })
        .where("app_id", "=", app.id).execute()

      const err = await updateProject(db, project.id, "userId", { slug: "serving-renamed" }).catch((e) => e)
      expect(err).toBeInstanceOf(ServiceError)
      expect((err as ServiceError).status).toBe(409)
      expect(await queuedSlugs(project.id)).toEqual([])
    })

    it("un-queues the namespace when renamed back before cleanup ran", async () => {
      const project = await makeProject("round-trip")
      await updateProject(db, project.id, "userId", { slug: "round-trip-b" })
      await updateProject(db, project.id, "userId", { slug: "round-trip" })

      expect(await queuedSlugs(project.id)).toEqual(["round-trip-b"])
    })
  })
})
