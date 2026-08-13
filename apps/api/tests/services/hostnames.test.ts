import { beforeAll, describe, it, expect } from "vitest"
import { ServiceError } from "../../src/services/errors"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { createApp } from "../../src/services/apps"
import { addHostname, deleteHostname, listHostnames } from "../../src/services/hostnames"

const db = createTestDb()

describe("services/hostnames", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))

    const now = new Date().toISOString()

    await db.insertInto("user").values({
      id: "userId", name: "Test User", email: "test@example.com",
      emailVerified: false, image: null, role: "developer",
      createdAt: now, updatedAt: now,
    }).execute()

    // A second, unrelated team + user — used to prove hostname management doesn't
    // require the caller to be a member of the app's team (that's the whole point
    // of getAppForAdmin bypassing getAppById; auth is enforced by requireAdmin at
    // the route layer, not by team membership here).
    await db.insertInto("user").values({
      id: "adminUserId", name: "Admin User", email: "admin@example.com",
      emailVerified: false, image: null, role: "admin",
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

  async function makeApp(slug: string, deploymentType: "web" | "private" | "cronjob" = "web") {
    return createApp(db, "projId", "userId", {
      name: slug, slug, sourceType: "git", gitUrl: "https://github.com/example/repo",
      deploymentType,
      schedule: deploymentType === "cronjob" ? "* * * * *" : undefined,
    })
  }

  it("lists hostnames (empty initially)", async () => {
    const app = await makeApp("host-test-app")
    const hosts = await listHostnames(db, app.id)
    expect(hosts).toEqual([])
  })

  it("adds a hostname to a web app", async () => {
    const app = await makeApp("host-add-app")
    const host = await addHostname(db, app.id, "App.Example.com")
    expect(host.hostname).toBe("app.example.com") // lowercase-normalized
    expect(host.appId).toBe(app.id)

    const hosts = await listHostnames(db, app.id)
    expect(hosts).toHaveLength(1)
  })

  it("rejects an invalid hostname format", async () => {
    const app = await makeApp("host-invalid-app")
    await expect(addHostname(db, app.id, "not a hostname")).rejects.toThrow(ServiceError)
    await expect(addHostname(db, app.id, "no-tld")).rejects.toThrow(ServiceError)
  })

  it("rejects hostnames on non-web apps", async () => {
    const privateApp = await makeApp("host-private-app", "private")
    await expect(addHostname(db, privateApp.id, "private.example.com")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 422,
    })

    const cronApp = await makeApp("host-cron-app", "cronjob")
    await expect(addHostname(db, cronApp.id, "cron.example.com")).rejects.toMatchObject({
      status: 422,
    })
  })

  it("rejects a hostname that is already assigned to another app", async () => {
    const appA = await makeApp("host-conflict-a")
    const appB = await makeApp("host-conflict-b")
    await addHostname(db, appA.id, "shared.example.com")
    await expect(addHostname(db, appB.id, "shared.example.com")).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    })
  })

  it("404s when adding a hostname to a nonexistent app", async () => {
    await expect(addHostname(db, "does-not-exist", "app.example.com")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    })
  })

  it("deletes a hostname", async () => {
    const app = await makeApp("host-delete-app")
    const host = await addHostname(db, app.id, "delete-me.example.com")
    await deleteHostname(db, app.id, host.id)
    expect(await listHostnames(db, app.id)).toEqual([])
  })

  it("404s when deleting a hostname that doesn't belong to the app", async () => {
    const appA = await makeApp("host-delete-a")
    const appB = await makeApp("host-delete-b")
    const host = await addHostname(db, appA.id, "belongs-to-a.example.com")
    await expect(deleteHostname(db, appB.id, host.id)).rejects.toMatchObject({ status: 404 })
  })

  it("allows managing hostnames on an app whose team the caller isn't a member of", async () => {
    // No team_members row links adminUserId to teamId — addHostname/listHostnames/
    // deleteHostname take no userId at all, proving authorization here is purely
    // the route-level requireAdmin middleware, not team membership.
    const app = await makeApp("host-cross-team-app")
    const host = await addHostname(db, app.id, "cross-team.example.com")
    expect(host.hostname).toBe("cross-team.example.com")
    expect(await listHostnames(db, app.id)).toHaveLength(1)
    await deleteHostname(db, app.id, host.id)
    expect(await listHostnames(db, app.id)).toEqual([])
  })
})
