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

  describe("env vars", () => {
    it("sets, lists and deletes an env var", async () => {
      const set = await handleTool("set_env_var", { app_id: appId, key: "LOG_LEVEL", value: "debug" }, "userId")
      expect(set.isError).toBeUndefined()
      // Env vars are runtime-only: the agent must be steered to a redeploy, not a rebuild.
      expect(JSON.parse(text(set)).note).toContain("apply it with redeploy_deployment")

      const listed = JSON.parse(text(await handleTool("list_env_vars", { app_id: appId }, "userId")))
      expect(listed.envVars).toEqual([{ key: "LOG_LEVEL", value: "debug" }])

      // An empty string is a valid value, not a missing argument.
      const emptied = await handleTool("set_env_var", { app_id: appId, key: "LOG_LEVEL", value: "" }, "userId")
      expect(emptied.isError).toBeUndefined()

      const deleted = await handleTool("delete_env_var", { app_id: appId, key: "LOG_LEVEL" }, "userId")
      expect(deleted.isError).toBeUndefined()
      const again = await handleTool("delete_env_var", { app_id: appId, key: "LOG_LEVEL" }, "userId")
      expect(again.isError).toBe(true)
    })

    it("rejects invalid, reserved and oversized input", async () => {
      for (const args of [
        { app_id: appId, key: "lower-case", value: "x" },
        { app_id: appId, key: "PORT", value: "8080" },
        { app_id: appId, key: "BIG", value: "x".repeat(10 * 1024 + 1) },
        { app_id: appId, key: "NO_VALUE" },
      ]) {
        const result = await handleTool("set_env_var", args, "userId")
        expect(result.isError).toBe(true)
      }
    })

    it("lists secret names without values and refuses to shadow a secret", async () => {
      const now = new Date().toISOString()
      await db.insertInto("secrets").values({
        id: "secretId", app_id: appId, key: "DATABASE_URL", encrypted_value: "ciphertext",
        created_at: now, updated_at: now,
      }).execute()

      const result = await handleTool("list_env_vars", { app_id: appId }, "userId")
      expect(JSON.parse(text(result)).secretKeys).toEqual(["DATABASE_URL"])
      expect(text(result)).not.toContain("ciphertext")

      const shadow = await handleTool("set_env_var", { app_id: appId, key: "DATABASE_URL", value: "x" }, "userId")
      expect(shadow.isError).toBe(true)
    })

    it("denies access to users outside the app's team", async () => {
      for (const [tool, args] of [
        ["list_env_vars", {}],
        ["set_env_var", { key: "A", value: "b" }],
        ["delete_env_var", { key: "A" }],
      ] as const) {
        const result = await handleTool(tool, { app_id: appId, ...args }, "outsiderId")
        expect(result.isError).toBe(true)
      }
    })
  })

  describe("app configuration", () => {
    const PROJECT_ID = "11111111-2222-3333-4444-555555555555"

    beforeAll(async () => {
      const now = new Date().toISOString()
      await db.insertInto("git_credentials").values({
        id: "credId", team_id: "teamId", name: "Deploy token", provider: "github", type: "pat",
        encrypted_value: "ciphertext", ssh_known_hosts: null, installation_id: null,
        connected_by_user_id: null, created_at: now,
      }).execute()
    })

    it("list_git_credentials returns names and types but never the stored value", async () => {
      const result = await handleTool("list_git_credentials", { project_id: "test-project" }, "userId")
      expect(JSON.parse(text(result))).toEqual([
        { id: "credId", name: "Deploy token", provider: "github", type: "pat", scope: "team" },
      ])
      expect(text(result)).not.toContain("ciphertext")
    })

    it("create_app supports monorepo paths and private repositories", async () => {
      const result = await handleTool(
        "create_app",
        {
          project_id: PROJECT_ID, name: "Docs", slug: "docs",
          git_url: "https://github.com/example/mono", app_path: "apps/docs", git_credential_id: "credId",
        },
        "userId"
      )
      expect(result.isError).toBeUndefined()
      const app = JSON.parse(text(result))
      expect(app.sourceType).toBe("git")
      expect(app.gitBranch).toBe("main")
      expect(app.appPath).toBe("apps/docs")
      expect(app.gitCredentialId).toBe("credId")
      expect(app.port).toBe(3000)
    })

    it("create_app supports image-based cronjobs and validates them", async () => {
      const base = { project_id: PROJECT_ID, name: "Nightly", slug: "nightly", source_type: "image", image_url: "ghcr.io/example/job" }

      const noSchedule = await handleTool("create_app", { ...base, deployment_type: "cronjob" }, "userId")
      expect(noSchedule.isError).toBe(true)

      const result = await handleTool("create_app", { ...base, deployment_type: "cronjob", schedule: "0 2 * * *" }, "userId")
      expect(result.isError).toBeUndefined()
      const app = JSON.parse(text(result))
      expect(app.sourceType).toBe("image")
      expect(app.imageTag).toBe("latest")
      expect(app.deploymentType).toBe("cronjob")
      expect(app.schedule).toBe("0 2 * * *")

      const noSource = await handleTool("create_app", { project_id: PROJECT_ID, name: "Empty", slug: "empty" }, "userId")
      expect(noSource.isError).toBe(true)
    })

    it("update_app changes only the fields passed", async () => {
      const created = JSON.parse(text(await handleTool(
        "create_app",
        { project_id: PROJECT_ID, name: "Api", slug: "api", git_url: "https://github.com/example/api", git_credential_id: "credId" },
        "userId"
      )))

      const result = await handleTool("update_app", { app_id: created.id, git_branch: "develop", port: "8080" }, "userId")
      expect(result.isError).toBeUndefined()
      const updated = JSON.parse(text(result))
      expect(updated.gitBranch).toBe("develop")
      expect(updated.port).toBe(8080)
      expect(updated.name).toBe("Api")
      expect(updated.gitCredentialId).toBe("credId")
      // A branch change alters the build source, so this one does need a build.
      expect(updated.note).toContain("call trigger_deployment")

      const portOnly = JSON.parse(text(await handleTool("update_app", { app_id: created.id, port: "9090" }, "userId")))
      expect(portOnly.note).toContain("apply it with redeploy_deployment")

      const cleared = JSON.parse(text(await handleTool("update_app", { app_id: created.id, git_credential_id: null }, "userId")))
      expect(cleared.gitCredentialId).toBeUndefined()

      const empty = await handleTool("update_app", { app_id: created.id }, "userId")
      expect(empty.isError).toBe(true)
      const toCron = await handleTool("update_app", { app_id: created.id, deployment_type: "cronjob", schedule: "@daily" }, "userId")
      expect(toCron.isError).toBe(true)
      const outsider = await handleTool("update_app", { app_id: created.id, port: 9000 }, "outsiderId")
      expect(outsider.isError).toBe(true)
    })

    it("redeploy_deployment reuses a built image and rejects one without", async () => {
      const deployment = JSON.parse(text(await handleTool("trigger_deployment", { app_id: appId }, "userId")))

      const noImage = await handleTool("redeploy_deployment", { deployment_id: deployment.id }, "userId")
      expect(noImage.isError).toBe(true)
      expect(text(noImage)).toContain("no built image")

      await db.updateTable("deployments").set({ image_digest: "sha256:abc", status: "live" }).where("id", "=", deployment.id).execute()
      const result = await handleTool("redeploy_deployment", { deployment_id: deployment.id }, "userId")
      expect(result.isError).toBeUndefined()
      const redeployed = JSON.parse(text(result))
      expect(redeployed.id).not.toBe(deployment.id)
      expect(redeployed.appId).toBe(appId)

      const outsider = await handleTool("redeploy_deployment", { deployment_id: deployment.id }, "outsiderId")
      expect(outsider.isError).toBe(true)
    })
  })
})
