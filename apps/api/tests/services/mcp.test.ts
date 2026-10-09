import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { createApp } from "../../src/services/apps"

const db = createTestDb()

// handleTool reads the module-level db — point it at the in-memory test db.
mock.module("../../src/db/db", () => ({ db }))
const { handleTool } = await import("../../src/services/mcp")

const realFetch = globalThis.fetch
let fetchedUrls: string[] = []

function stubLogstreamer(body: unknown, status = 200) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchedUrls.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
}

function text(result: Awaited<ReturnType<typeof handleTool>>, i = 0): string {
  return result.content[i]!.text
}

describe("services/mcp runtime diagnostics", () => {
  let appId: string

  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))
    const now = new Date().toISOString()

    for (const id of ["userId", "outsiderId"]) {
      await db.insertInto("user").values({
        id, name: id, email: `${id}@example.com`,
        emailVerified: false, image: null, role: "developer",
        createdAt: now, updatedAt: now,
      }).execute()
    }
    await db.insertInto("teams").values({
      id: "teamId", name: "Test Team", is_personal: true, owner_id: "userId",
      created_at: now, updated_at: now,
    }).execute()
    await db.insertInto("team_members").values({
      id: "memberId", team_id: "teamId", user_id: "userId", created_at: now,
    }).execute()
    await db.insertInto("projects").values({
      id: "11111111-2222-3333-4444-555555555555", team_id: "teamId", name: "Test Project",
      slug: "test-project", description: null, created_by: "userId", created_at: now, updated_at: now,
    }).execute()

    const app = await createApp(db, "11111111-2222-3333-4444-555555555555", "userId", {
      name: "web", slug: "web", sourceType: "git", gitUrl: "https://github.com/example/repo",
    })
    appId = app.id
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    fetchedUrls = []
  })

  it("get_app returns app state with hostnames and latest deployment", async () => {
    const result = await handleTool("get_app", { app_id: appId }, "userId")
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(text(result))
    expect(body.slug).toBe("web")
    expect(body.hostnames).toEqual([])
    expect(body.latestDeployment).toBeNull()
  })

  it("denies access to users outside the app's team", async () => {
    for (const tool of ["get_app", "get_runtime_logs", "get_app_metrics"]) {
      const result = await handleTool(tool, { app_id: appId }, "outsiderId")
      expect(result.isError).toBe(true)
    }
  })

  it("get_runtime_logs returns pod status and logs as separate blocks", async () => {
    stubLogstreamer({
      found: true, pod: "web-abc", phase: "Running", ready: false, restarts: 3,
      waitingReason: "CrashLoopBackOff", lastExitCode: 1, previous: true,
      logs: "Error: missing DATABASE_URL\n",
    })
    const result = await handleTool("get_runtime_logs", { app_id: appId, lines: 5000 }, "userId")
    expect(result.isError).toBeUndefined()
    const status = JSON.parse(text(result, 0))
    expect(status.waitingReason).toBe("CrashLoopBackOff")
    expect(status.logs).toBeUndefined()
    expect(text(result, 1)).toContain("missing DATABASE_URL")

    const url = new URL(fetchedUrls[0]!)
    expect(url.pathname).toBe("/logs/tail")
    expect(url.searchParams.get("app")).toBe("web")
    expect(url.searchParams.get("lines")).toBe("1000") // clamped to max
    expect(url.searchParams.has("deployment_id")).toBe(false)
  })

  it("get_runtime_logs explains when the app has no pods", async () => {
    stubLogstreamer({ found: false, ready: false, restarts: 0, previous: false, logs: "" })
    const result = await handleTool("get_runtime_logs", { app_id: appId }, "userId")
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain("No pods found")
  })

  it("get_runtime_logs rejects a deployment from another app", async () => {
    const result = await handleTool(
      "get_runtime_logs",
      { app_id: appId, deployment_id: "00000000-0000-0000-0000-000000000000" },
      "userId"
    )
    expect(result.isError).toBe(true)
    expect(fetchedUrls).toEqual([])
  })

  it("get_app_metrics proxies usage and reports upstream failures as tool errors", async () => {
    stubLogstreamer({ usageAvailable: false, pods: [{ name: "web-abc", ready: true, restarts: 0 }] })
    const ok = await handleTool("get_app_metrics", { app_id: appId }, "userId")
    expect(JSON.parse(text(ok)).pods[0].name).toBe("web-abc")
    expect(new URL(fetchedUrls[0]!).pathname).toBe("/metrics/usage")

    stubLogstreamer({ error: "boom" }, 500)
    const failed = await handleTool("get_app_metrics", { app_id: appId }, "userId")
    expect(failed.isError).toBe(true)
  })
})
