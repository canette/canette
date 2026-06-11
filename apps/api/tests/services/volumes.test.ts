import { beforeAll, describe, it, expect } from "vitest"
import { ServiceError } from "../../src/services/errors"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { createApp } from "../../src/services/apps"
import { createVolume, deleteVolume, listVolumes } from "../../src/services/volumes"

const db = createTestDb()

describe("services/volumes", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))

    const now = new Date().toISOString()

    await db.insertInto("user").values({
      id: "userId", name: "Test User", email: "test@example.com",
      emailVerified: false, image: null, role: "developer",
      createdAt: now, updatedAt: now,
    }).execute()

    await db.insertInto("teams").values({
      id: "teamId", name: "Test Team", is_personal: true, owner_id: "userId",
      created_at: now, updated_at: now,
    }).execute()

    await db.insertInto("team_members").values({
      id: "memberId", team_id: "teamId", user_id: "userId", created_at: now,
    }).execute()

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

  it("lists volumes (empty initially)", async () => {
    const app = await makeApp("vol-test-app")
    const vols = await listVolumes(db, app.id)
    expect(vols).toEqual([])
  })

  it("creates a PVC volume and auto-generates name from path", async () => {
    const app = await makeApp("pvc-app")
    const vol = await createVolume(db, app.id, "userId", {
      type: "pvc", mountPath: "/data", config: { size: "5Gi" },
    })
    expect(vol.name).toBe("data")
    expect(vol.type).toBe("pvc")
    expect(vol.mountPath).toBe("/data")
    expect(vol.config.size).toBe("5Gi")

    const vols = await listVolumes(db, app.id)
    expect(vols).toHaveLength(1)
  })

  it("derives name from nested path", async () => {
    const app = await makeApp("nested-app")
    const vol = await createVolume(db, app.id, "userId", {
      type: "configmap", mountPath: "/etc/nginx/nginx.conf",
      config: { content: "worker_processes 1;" },
    })
    expect(vol.name).toBe("etc-nginx-nginx-conf")
    expect(vol.type).toBe("configmap")
    expect(vol.config.content).toBe("worker_processes 1;")
  })

  it("creates an emptyDir volume", async () => {
    const app = await makeApp("emptydir-app")
    const vol = await createVolume(db, app.id, "userId", {
      type: "emptyDir", mountPath: "/tmp/cache", config: { size: "500Mi" },
    })
    expect(vol.name).toBe("tmp-cache")
    expect(vol.type).toBe("emptyDir")
    expect(vol.config.size).toBe("500Mi")
  })

  it("rejects PVC without size", async () => {
    const app = await makeApp("pvc-nosize-app")
    await expect(
      createVolume(db, app.id, "userId", { type: "pvc", mountPath: "/data" })
    ).rejects.toThrow(ServiceError)
  })

  it("rejects configmap without content", async () => {
    const app = await makeApp("cm-nocontent-app")
    await expect(
      createVolume(db, app.id, "userId", { type: "configmap", mountPath: "/etc/app.conf" })
    ).rejects.toThrow(ServiceError)
  })

  it("rejects non-absolute mount path", async () => {
    const app = await makeApp("badpath-app")
    await expect(
      createVolume(db, app.id, "userId", { type: "emptyDir", mountPath: "relative/path" })
    ).rejects.toThrow(ServiceError)
  })

  it("rejects duplicate mount path on same app", async () => {
    const app = await makeApp("dup-path-app")
    await createVolume(db, app.id, "userId", { type: "emptyDir", mountPath: "/shared" })
    await expect(
      createVolume(db, app.id, "userId", { type: "emptyDir", mountPath: "/shared" })
    ).rejects.toThrow(ServiceError)
  })

  it("deletes a volume and queues pending deletion for PVC", async () => {
    const app = await makeApp("delete-pvc-app")
    const vol = await createVolume(db, app.id, "userId", {
      type: "pvc", mountPath: "/data", config: { size: "1Gi" },
    })

    await deleteVolume(db, app.id, vol.id, "userId")

    const remaining = await listVolumes(db, app.id)
    expect(remaining).toHaveLength(0)

    const pending = await db
      .selectFrom("pending_volume_deletions")
      .selectAll()
      .where("resource_name", "=", `${app.slug}-data`)
      .executeTakeFirst()
    expect(pending).toBeDefined()
    expect(pending?.resource_type).toBe("PersistentVolumeClaim")
  })

  it("deletes an emptyDir volume without queuing pending deletion", async () => {
    const app = await makeApp("delete-emptydir-app")
    const vol = await createVolume(db, app.id, "userId", {
      type: "emptyDir", mountPath: "/tmp/scratch",
    })

    await deleteVolume(db, app.id, vol.id, "userId")

    const remaining = await listVolumes(db, app.id)
    expect(remaining).toHaveLength(0)

    const count = await db
      .selectFrom("pending_volume_deletions")
      .select(db.fn.countAll<number>().as("n"))
      .where("namespace", "like", "%-delete-emptydir-app")
      .executeTakeFirst()
    expect(Number(count?.n ?? 0)).toBe(0)
  })

  it("rejects access for unrelated user", async () => {
    const app = await makeApp("unrelated-app")
    await expect(
      createVolume(db, app.id, "otherUserId", { type: "emptyDir", mountPath: "/data" })
    ).rejects.toThrow(ServiceError)
  })
})
