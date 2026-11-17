import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { createApp } from "../../src/services/apps"
import { createVolume } from "../../src/services/volumes"
import { enablePasswordGate, getPasswordGateStatus } from "../../src/services/password-gate"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const db = createTestDb()
process.env.ENCRYPTION_KEY ??= "00".repeat(32)

// handleTool reads the module-level db — point it at the in-memory test db.
mock.module("../../src/db/db", () => ({ db }))
const { handleTool, buildMcpServer, searchDocsTool, getDocsPageTool, getSchemaTool, ALL_TOOLS } = await import("../../src/services/mcp")
const { createDocsIndex } = await import("../../src/docs")
const { encrypt, decrypt } = await import("../../src/utils/crypto")

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
        ["request_secret", { keys: ["A"] }],
      ] as const) {
        const result = await handleTool(tool, { app_id: appId, ...args }, "outsiderId")
        expect(result.isError).toBe(true)
      }
    })
  })

  describe("request_secret", () => {
    async function counts() {
      const [s, e] = await Promise.all([
        db.selectFrom("secrets").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow(),
        db.selectFrom("env_vars").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow(),
      ])
      return [Number(s.n), Number(e.n)]
    }

    it("returns a UI link for the keys, with each key's current state, and writes nothing", async () => {
      // DATABASE_URL is already a secret (set in the env vars tests above).
      await handleTool("set_env_var", { app_id: appId, key: "API_TOKEN", value: "plain" }, "userId")
      const before = await counts()

      const result = await handleTool("request_secret", {
        app_id: appId,
        keys: ["STRIPE_KEY", "DATABASE_URL", "API_TOKEN", "STRIPE_KEY"],
        reason: "  The app\nfails at startup <b>without</b> these  ",
      }, "userId")
      expect(result.isError).toBeUndefined()
      const body = JSON.parse(text(result))

      const url = new URL(body.url)
      expect(url.pathname).toBe("/dashboard/projects/test-project/apps/web/request-secrets")
      expect(url.searchParams.get("keys")).toBe("STRIPE_KEY,DATABASE_URL,API_TOKEN")
      expect(url.searchParams.get("reason")).toBe("The app fails at startup <b>without</b> these")
      expect(body.keys).toEqual([
        { key: "STRIPE_KEY", status: "new" },
        { key: "DATABASE_URL", status: "replaces_secret" },
        { key: "API_TOKEN", status: "replaces_env_var" },
      ])
      expect(body.note).toContain("redeploy_deployment")
      expect(await counts()).toEqual(before)

      await handleTool("delete_env_var", { app_id: appId, key: "API_TOKEN" }, "userId")
    })

    it("leaves the reason out of the link when none is given", async () => {
      const result = await handleTool("request_secret", { app_id: appId, keys: ["STRIPE_KEY"] }, "userId")
      expect(new URL(JSON.parse(text(result)).url).searchParams.has("reason")).toBe(false)
    })

    it("rejects invalid, reserved, missing and too many keys, and an over-long reason", async () => {
      for (const args of [
        { app_id: appId },
        { app_id: appId, keys: [] },
        { app_id: appId, keys: [42] },
        { app_id: appId, keys: ["lower-case"] },
        { app_id: appId, keys: ["PORT"] },
        { app_id: appId, keys: Array.from({ length: 11 }, (_, i) => `KEY_${i}`) },
        { app_id: appId, keys: ["OK"], reason: "x".repeat(301) },
        { keys: ["OK"] },
      ]) {
        const result = await handleTool("request_secret", args, "userId")
        expect(result.isError).toBe(true)
      }
    })
  })

  describe("password protection", () => {
    let privateAppId: string

    beforeAll(async () => {
      const app = await createApp(db, "11111111-2222-3333-4444-555555555555", "userId", {
        name: "internal", slug: "internal", sourceType: "git", gitUrl: "https://github.com/example/repo",
        deploymentType: "private",
      })
      privateAppId = app.id
    })

    it("get_app reports whether password protection is on", async () => {
      const body = JSON.parse(text(await handleTool("get_app", { app_id: appId }, "userId")))
      expect(body.passwordProtection).toEqual({ enabled: false })
    })

    it("disable_password_protection is a no-op when protection is off", async () => {
      const result = await handleTool("disable_password_protection", { app_id: appId }, "userId")
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(text(result)).enabled).toBe(false)
    })

    it("request_password_protection returns a UI link with the reason and writes nothing", async () => {
      const result = await handleTool("request_password_protection", {
        app_id: appId, reason: "  Keep the demo\nprivate  ",
      }, "userId")
      expect(result.isError).toBeUndefined()
      const body = JSON.parse(text(result))
      const url = new URL(body.url)
      expect(url.pathname).toBe("/dashboard/projects/test-project/apps/web/request-password-protection")
      expect(url.searchParams.get("reason")).toBe("Keep the demo private")
      expect(body.currentlyEnabled).toBe(false)
      expect(body.note).toContain("redeploy_deployment")
      expect(await getPasswordGateStatus(db, appId, "userId")).toEqual({ enabled: false })
    })

    it("leaves the reason out of the link when none is given", async () => {
      const result = await handleTool("request_password_protection", { app_id: appId }, "userId")
      expect(new URL(JSON.parse(text(result)).url).search).toBe("")
    })

    it("rejects non-web apps, an over-long reason and a missing app_id", async () => {
      for (const args of [
        { app_id: privateAppId },
        { app_id: appId, reason: "x".repeat(301) },
        {},
      ]) {
        const result = await handleTool("request_password_protection", args, "userId")
        expect(result.isError).toBe(true)
      }
    })

    it("once protection is on, reports it and only links to settings to disable it", async () => {
      await enablePasswordGate(db, appId, "userId", { password: "hunter2" })

      const app = JSON.parse(text(await handleTool("get_app", { app_id: appId }, "userId")))
      expect(app.passwordProtection).toEqual({ enabled: true })
      const request = JSON.parse(text(await handleTool("request_password_protection", { app_id: appId }, "userId")))
      expect(request.currentlyEnabled).toBe(true)

      const result = await handleTool("disable_password_protection", { app_id: appId }, "userId")
      expect(result.isError).toBe(true)
      expect(text(result)).toContain("/dashboard/projects/test-project/apps/web/settings#access")
      expect(await getPasswordGateStatus(db, appId, "userId")).toEqual({ enabled: true })
    })

    it("denies access to users outside the app's team", async () => {
      for (const tool of ["request_password_protection", "disable_password_protection"]) {
        const result = await handleTool(tool, { app_id: appId }, "outsiderId")
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

    it("create_app stores canette_config", async () => {
      const result = await handleTool(
        "create_app",
        {
          project_id: PROJECT_ID, name: "Cache", slug: "cache", source_type: "image", image_url: "redis",
          canette_config: "replicas: 2\nresources:\n  limits:\n    memory: 256Mi\n",
        },
        "userId"
      )
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(text(result)).canetteConfig).toBe("replicas: 2\nresources:\n  limits:\n    memory: 256Mi\n")

      const invalid = await handleTool(
        "create_app",
        { project_id: PROJECT_ID, name: "Broken", slug: "broken", source_type: "image", image_url: "redis", canette_config: "replicas: [1" },
        "userId"
      )
      expect(invalid.isError).toBe(true)
      expect(text(invalid)).toContain("not valid YAML")
    })

    it("update_app sets, replaces and clears canette_config as a runtime change", async () => {
      const created = JSON.parse(text(await handleTool(
        "create_app",
        { project_id: PROJECT_ID, name: "Worker", slug: "worker", source_type: "image", image_url: "ghcr.io/example/worker" },
        "userId"
      )))
      const update = async (canette_config: unknown) =>
        handleTool("update_app", { app_id: created.id, canette_config }, "userId")

      const set = JSON.parse(text(await update("replicas: 2\n")))
      expect(set.canetteConfig).toBe("replicas: 2\n")
      expect(set.note).toContain("apply it with redeploy_deployment")

      const replaced = JSON.parse(text(await update("healthcheck:\n  path: /healthz\n")))
      expect(replaced.canetteConfig).toBe("healthcheck:\n  path: /healthz\n")

      expect(JSON.parse(text(await update(null))).canetteConfig).toBeUndefined()
      await update("replicas: 1\n")
      expect(JSON.parse(text(await update(""))).canetteConfig).toBeUndefined()
    })

    it("update_app rejects invalid canette_config with a readable error", async () => {
      const created = JSON.parse(text(await handleTool(
        "create_app",
        { project_id: PROJECT_ID, name: "Validate", slug: "validate", source_type: "image", image_url: "nginx", canette_config: "replicas: 1\n" },
        "userId"
      )))
      const update = (canette_config: unknown) => handleTool("update_app", { app_id: created.id, canette_config }, "userId")

      const badYaml = await update("replicas: 1\nresources:\n  limits: {cpu: 1\n")
      expect(badYaml.isError).toBe(true)
      expect(text(badYaml)).toMatch(/not valid YAML: .+ \(line \d+, column \d+\)/)

      const notMapping = await update("- replicas: 1\n")
      expect(notMapping.isError).toBe(true)
      expect(text(notMapping)).toContain("YAML mapping")

      const oversize = await update(`# ${"x".repeat(11 * 1024)}\n`)
      expect(oversize.isError).toBe(true)
      expect(text(oversize)).toContain("10 KB")

      // An object instead of a YAML string must not be read as "clear it".
      const object = await update({ replicas: 2 })
      expect(object.isError).toBe(true)

      const app = JSON.parse(text(await handleTool("get_app", { app_id: created.id }, "userId")))
      expect(app.canetteConfig).toBe("replicas: 1\n")
    })

    it("update_app refuses replicas > 1 while the app has a PVC", async () => {
      const created = JSON.parse(text(await handleTool(
        "create_app",
        { project_id: PROJECT_ID, name: "Db", slug: "db", source_type: "image", image_url: "postgres" },
        "userId"
      )))
      await createVolume(db, created.id, "userId", { type: "pvc", mountPath: "/data", config: { size: "1Gi" } })

      const result = await handleTool("update_app", { app_id: created.id, canette_config: "replicas: 2\n" }, "userId")
      expect(result.isError).toBe(true)
      expect(text(result)).toContain("PVC")
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

  describe("volumes", () => {
    const PROJECT_ID = "11111111-2222-3333-4444-555555555555"
    let volAppId: string

    beforeAll(async () => {
      const app = await createApp(db, PROJECT_ID, "userId", {
        name: "Vols", slug: "vols", sourceType: "image", imageUrl: "nginx",
      })
      volAppId = app.id
    })

    async function create(args: Record<string, unknown>) {
      return handleTool("create_volume", { app_id: volAppId, ...args }, "userId")
    }

    // Volumes created in the same millisecond have no stable order, so look them up by type.
    async function volumesByType() {
      const listed = JSON.parse(text(await handleTool("list_volumes", { app_id: volAppId }, "userId")))
      return Object.fromEntries(listed.map((v: { type: string }) => [v.type, v]))
    }

    async function pendingDeletions() {
      const row = await db.selectFrom("pending_volume_deletions").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow()
      return Number(row.n)
    }

    it("creates and lists all three types, and get_app summarises them", async () => {
      for (const args of [
        { type: "pvc", mount_path: "/data", size: "1Gi" },
        { type: "emptyDir", mount_path: "/cache" },
        { type: "configmap", mount_path: "/etc/nginx/nginx.conf", content: "events {}\n" },
      ]) {
        const result = await create(args)
        expect(result.isError).toBeUndefined()
        expect(JSON.parse(text(result)).note).toContain("redeploy_deployment")
      }

      const { pvc, emptyDir, configmap } = await volumesByType()
      expect(pvc).toMatchObject({ mountPath: "/data", config: { size: "1Gi" } })
      expect(emptyDir.mountPath).toBe("/cache")
      expect(configmap).toMatchObject({ mountPath: "/etc/nginx/nginx.conf", config: { content: "events {}\n" } })

      const app = JSON.parse(text(await handleTool("get_app", { app_id: volAppId }, "userId")))
      expect(app.volumes).toHaveLength(3)
      expect(app.volumes).toContainEqual({ id: pvc.id, name: pvc.name, type: "pvc", mountPath: "/data", size: "1Gi" })
      expect(JSON.stringify(app.volumes)).not.toContain("events")
    })

    it("returns validation errors as tool errors", async () => {
      for (const args of [
        { type: "pvc", mount_path: "/db" },
        { type: "pvc", mount_path: "/db", size: "lots" },
        { type: "emptyDir", mount_path: "/etc" },
        { type: "emptyDir", mount_path: "/data" },
        { type: "configmap", mount_path: "/app/config.json" },
        { type: "tmpfs", mount_path: "/scratch" },
        { mount_path: "/scratch" },
        { type: "emptyDir" },
      ]) {
        const result = await create(args)
        expect(result.isError).toBe(true)
      }
    })

    it("refuses a PVC on an app with more than one replica", async () => {
      const app = await createApp(db, PROJECT_ID, "userId", {
        name: "Scaled", slug: "scaled", sourceType: "image", imageUrl: "nginx", canetteConfig: "replicas: 2\n",
      })
      const result = await handleTool("create_volume", { app_id: app.id, type: "pvc", mount_path: "/data", size: "1Gi" }, "userId")
      expect(result.isError).toBe(true)
      expect(text(result)).toContain("replicas")
    })

    it("updates configmap content and emptyDir size, but not a PVC", async () => {
      const { pvc, emptyDir, configmap } = await volumesByType()

      const content = await handleTool("update_volume", { app_id: volAppId, volume_id: configmap.id, content: "events { worker_connections 64; }\n" }, "userId")
      expect(JSON.parse(text(content)).config.content).toContain("worker_connections")

      const sized = await handleTool("update_volume", { app_id: volAppId, volume_id: emptyDir.id, size: "256Mi" }, "userId")
      expect(JSON.parse(text(sized)).config.size).toBe("256Mi")
      const cleared = await handleTool("update_volume", { app_id: volAppId, volume_id: emptyDir.id, size: null }, "userId")
      expect(JSON.parse(text(cleared)).config.size).toBeUndefined()

      const frozen = await handleTool("update_volume", { app_id: volAppId, volume_id: pvc.id, size: "2Gi" }, "userId")
      expect(frozen.isError).toBe(true)
    })

    it("deletes emptyDir and configmap volumes but leaves a PVC to the user", async () => {
      const { pvc, emptyDir, configmap } = await volumesByType()
      const before = await pendingDeletions()

      const refused = await handleTool("delete_volume", { app_id: volAppId, volume_id: pvc.id }, "userId")
      expect(refused.isError).toBe(true)
      expect(text(refused)).toContain("/dashboard/projects/test-project/apps/vols/settings#volumes")
      expect(await pendingDeletions()).toBe(before)

      for (const volume of [emptyDir, configmap]) {
        const result = await handleTool("delete_volume", { app_id: volAppId, volume_id: volume.id }, "userId")
        expect(result.isError).toBeUndefined()
        expect(JSON.parse(text(result)).deleted).toBe(volume.name)
      }
      // Only the configmap leaves a cluster resource behind for the controller to remove.
      expect(await pendingDeletions()).toBe(before + 1)

      const remaining = JSON.parse(text(await handleTool("list_volumes", { app_id: volAppId }, "userId")))
      expect(remaining.map((v: { id: string }) => v.id)).toEqual([pvc.id])
    })

    it("denies access to users outside the app's team and to other apps' volumes", async () => {
      const { pvc } = await volumesByType()
      for (const [tool, args] of [
        ["list_volumes", {}],
        ["create_volume", { type: "emptyDir", mount_path: "/tmp/x" }],
        ["update_volume", { volume_id: pvc.id, size: "2Gi" }],
        ["delete_volume", { volume_id: pvc.id }],
      ] as const) {
        const result = await handleTool(tool, { app_id: volAppId, ...args }, "outsiderId")
        expect(result.isError).toBe(true)
        expect(text(result)).toContain("access denied")
      }

      for (const tool of ["update_volume", "delete_volume"]) {
        const result = await handleTool(tool, { app_id: appId, volume_id: pvc.id, size: "2Gi" }, "userId")
        expect(result.isError).toBe(true)
        expect(text(result)).toContain("not found")
      }
    })
  })

  describe("errors", () => {
    function error(result: Awaited<ReturnType<typeof handleTool>>) {
      expect(result.isError).toBe(true)
      return JSON.parse(text(result)) as { error: string; code: string }
    }

    it("reports invalid arguments as VALIDATION_ERROR", async () => {
      expect(error(await handleTool("get_app", {}, "userId"))).toEqual({ error: "app_id is required (or project_id and app_slug)", code: "VALIDATION_ERROR" })
    })

    it("reports a missing and an inaccessible app identically", async () => {
      const missing = error(await handleTool("get_app", { app_id: "00000000-0000-0000-0000-000000000000" }, "userId"))
      const denied = error(await handleTool("get_app", { app_id: appId }, "outsiderId"))
      expect(missing).toEqual({ error: "App not found or access denied", code: "NOT_FOUND" })
      expect(denied).toEqual(missing)
    })

    it("keeps a service error's own code", async () => {
      const result = error(await handleTool("create_app", {
        project_id: "11111111-2222-3333-4444-555555555555", name: "web", slug: "web", source_type: "git", git_url: "https://github.com/example/repo",
      }, "userId"))
      expect(result.code).toBe("CONFLICT")
      expect(result.error).toBe("An app with that slug already exists in this project")
    })

    it("reports an unknown tool and an unreachable backing service", async () => {
      expect(error(await handleTool("no_such_tool", {}, "userId")).code).toBe("UNKNOWN_TOOL")
      stubLogstreamer({ error: "boom" }, 500)
      expect(error(await handleTool("get_app_metrics", { app_id: appId }, "userId")).code).toBe("UNAVAILABLE")
    })
  })

  describe("teams and projects", () => {
    const PROJECT_ID = "11111111-2222-3333-4444-555555555555"

    function error(result: Awaited<ReturnType<typeof handleTool>>) {
      expect(result.isError).toBe(true)
      return JSON.parse(text(result)) as { error: string; code: string }
    }

    beforeAll(async () => {
      const now = new Date().toISOString()
      // A team owned by the outsider that userId has joined, with no projects:
      // list_projects can't find it, list_teams must.
      await db.insertInto("teams").values({
        id: "sharedTeamId", name: "Shared Team", is_personal: false, owner_id: "outsiderId",
        created_at: now, updated_at: now,
      }).execute()
      await db.insertInto("team_members").values([
        { id: "sharedOwner", team_id: "sharedTeamId", user_id: "outsiderId", created_at: now },
        { id: "sharedMember", team_id: "sharedTeamId", user_id: "userId", created_at: now },
      ]).execute()
    })

    it("list_teams returns the user's teams with the personal team and role", async () => {
      const result = await handleTool("list_teams", {}, "userId")
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(text(result))).toEqual([
        { id: "teamId", name: "Test Team", isPersonal: true, role: "owner" },
        { id: "sharedTeamId", name: "Shared Team", isPersonal: false, role: "member" },
      ])

      const outsider = JSON.parse(text(await handleTool("list_teams", {}, "outsiderId")))
      expect(outsider.map((t: { id: string }) => t.id)).toEqual(["sharedTeamId"])
    })

    it("get_app resolves an app by project ID or slug plus app slug", async () => {
      for (const project_id of ["test-project", PROJECT_ID]) {
        const result = await handleTool("get_app", { project_id, app_slug: "web" }, "userId")
        expect(result.isError).toBeUndefined()
        const body = JSON.parse(text(result))
        expect(body.id).toBe(appId)
        expect(body.hostnames).toEqual([])
      }
    })

    it("get_app rejects ambiguous or incomplete app references", async () => {
      for (const args of [
        { app_id: appId, project_id: "test-project", app_slug: "web" },
        { app_id: appId, app_slug: "web" },
        { project_id: "test-project" },
        { app_slug: "web" },
      ]) {
        expect(error(await handleTool("get_app", args, "userId")).code).toBe("VALIDATION_ERROR")
      }
    })

    it("get_app by slug reports a missing and an inaccessible app identically", async () => {
      const missing = error(await handleTool("get_app", { project_id: "test-project", app_slug: "nope" }, "userId"))
      const denied = error(await handleTool("get_app", { project_id: "test-project", app_slug: "web" }, "outsiderId"))
      expect(missing).toEqual({ error: "App not found or access denied", code: "NOT_FOUND" })
      expect(denied).toEqual(missing)
    })

    describe("update_project", () => {
      const ID = "22222222-3333-4444-5555-666666666666"

      beforeAll(async () => {
        const now = new Date().toISOString()
        await db.insertInto("projects").values({
          id: ID, team_id: "teamId", name: "Editable", slug: "editable", description: "old",
          created_by: "userId", created_at: now, updated_at: now,
        }).execute()
      })

      const row = () => db.selectFrom("projects").select(["name", "slug", "description"]).where("id", "=", ID).executeTakeFirstOrThrow()

      it("changes the name and description, by ID or slug", async () => {
        const result = await handleTool("update_project", { project_id: ID, name: "  Renamed  ", description: "new" }, "userId")
        expect(result.isError).toBeUndefined()
        expect(JSON.parse(text(result)).name).toBe("Renamed")
        expect(await row()).toEqual({ name: "Renamed", slug: "editable", description: "new" })

        await handleTool("update_project", { project_id: "editable", name: "By slug" }, "userId")
        expect((await row()).name).toBe("By slug")
        expect((await row()).description).toBe("new") // untouched when absent
      })

      it("clears the description with null or an empty string", async () => {
        for (const description of [null, ""]) {
          await handleTool("update_project", { project_id: ID, description: "set" }, "userId")
          expect((await handleTool("update_project", { project_id: ID, description }, "userId")).isError).toBeUndefined()
          expect((await row()).description).toBeNull()
        }
      })

      it("rejects an empty patch, invalid values and a slug change", async () => {
        for (const args of [{}, { name: "" }, { name: "   " }, { name: 5 }, { description: 5 }, { slug: "renamed" }]) {
          expect(error(await handleTool("update_project", { project_id: ID, ...args }, "userId")).code).toBe("VALIDATION_ERROR")
        }
        expect(error(await handleTool("update_project", { name: "x" }, "userId")).code).toBe("VALIDATION_ERROR")
        expect((await row()).slug).toBe("editable")
      })

      it("denies access to users outside the project's team", async () => {
        const denied = error(await handleTool("update_project", { project_id: ID, name: "Hijacked" }, "outsiderId"))
        expect(denied).toEqual({ error: "Project not found or access denied", code: "NOT_FOUND" })
        expect((await row()).name).not.toBe("Hijacked")
      })
    })
  })

  describe("parse_template", () => {
    const TEMPLATE = [
      "name: Demo stack",
      "description: Web app and worker",
      "apps:",
      "  - name: Web",
      "    slug: web",
      "    git_url: https://github.com/example/web",
      "    port: 8080",
      "    env:",
      "      LOG_LEVEL: info",
      "    secrets:",
      "      - DATABASE_URL",
      "      - name: API_KEY",
      "        description: Payment provider key",
      "    replicas: 2",
      "  - name: Nightly",
      "    slug: nightly",
      "    source_type: image",
      "    image_url: ghcr.io/example/job",
      "    deployment_type: cronjob",
      "    schedule: '@daily'",
    ].join("\n")

    function error(result: Awaited<ReturnType<typeof handleTool>>) {
      expect(result.isError).toBe(true)
      return JSON.parse(text(result)) as { error: string; code: string }
    }

    it("returns the parsed apps and keeps unknown fields as canetteConfig", async () => {
      const appsBefore = await db.selectFrom("apps").select("id").execute()
      const result = await handleTool("parse_template", { yaml: TEMPLATE }, "userId")
      expect(result.isError).toBeUndefined()
      const body = JSON.parse(text(result))
      expect(body.name).toBe("Demo stack")
      expect(body.apps).toHaveLength(2)
      expect(body.apps[0]).toMatchObject({
        slug: "web", sourceType: "git", gitUrl: "https://github.com/example/web", port: 8080,
        env: { LOG_LEVEL: "info" },
        secrets: [{ name: "DATABASE_URL" }, { name: "API_KEY", description: "Payment provider key" }],
        canetteConfig: "replicas: 2\n",
      })
      expect(body.apps[1]).toMatchObject({ slug: "nightly", deploymentType: "cronjob", schedule: "@daily" })
      // Parsing creates nothing.
      expect(await db.selectFrom("apps").select("id").execute()).toEqual(appsBefore)
    })

    it("keeps the parser's error codes and messages", async () => {
      expect(error(await handleTool("parse_template", { yaml: "name: [unclosed" }, "userId")))
        .toEqual({ error: "Invalid YAML: could not parse template", code: "INVALID_YAML" })
      expect(error(await handleTool("parse_template", { yaml: "apps: []" }, "userId")))
        .toEqual({ error: "Template 'name' is required", code: "INVALID_TEMPLATE" })
      expect(error(await handleTool("parse_template", { yaml: "" }, "userId")).code).toBe("INVALID_TEMPLATE")
      expect(error(await handleTool("parse_template", { yaml: `name: x\n#${"a".repeat(60_000)}` }, "userId")).code).toBe("TOO_LARGE")
    })

    it("rejects a missing or non-string document", async () => {
      for (const args of [{}, { yaml: { name: "x" } }]) {
        expect(error(await handleTool("parse_template", args, "userId")).code).toBe("VALIDATION_ERROR")
      }
    })
  })

  describe("deployments", () => {
    const PROJECT_ID = "11111111-2222-3333-4444-555555555555"
    let depAppId: string
    let seq = 0

    // Inserts a deployment created `seq` seconds after the previous one, so
    // newest-first ordering is deterministic.
    async function insertDeployment(app: string, status: "live" | "failed" | "building" | "stopped") {
      const id = crypto.randomUUID()
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString()
      await db.insertInto("deployments").values({
        id, app_id: app, status, commit_sha: "abc123", image_digest: status === "building" ? null : "sha256:abc",
        created_at: at, updated_at: at,
      }).execute()
      return id
    }

    beforeAll(async () => {
      const app = await createApp(db, PROJECT_ID, "userId", {
        name: "deploys", slug: "deploys", sourceType: "git", gitUrl: "https://github.com/example/repo",
      })
      depAppId = app.id
    })

    it("get_app returns the live deployment separately from a newer failed or unfinished one", async () => {
      await insertDeployment(depAppId, "stopped")
      const live = await insertDeployment(depAppId, "live")
      await insertDeployment(depAppId, "failed")
      const building = await insertDeployment(depAppId, "building")

      const body = JSON.parse(text(await handleTool("get_app", { app_id: depAppId }, "userId")))
      expect(body.liveDeployment.id).toBe(live)
      expect(body.liveDeployment.status).toBe("live")
      expect(body.latestDeployment.id).toBe(building)
    })

    it("get_app returns a null live deployment for a stopped app", async () => {
      const stopped = await createApp(db, PROJECT_ID, "userId", {
        name: "stopped", slug: "stopped", sourceType: "git", gitUrl: "https://github.com/example/repo",
      })
      const id = await insertDeployment(stopped.id, "stopped")

      const body = JSON.parse(text(await handleTool("get_app", { app_id: stopped.id }, "userId")))
      expect(body.liveDeployment).toBeNull()
      expect(body.latestDeployment.id).toBe(id)
    })

    it("list_deployments defaults to 10, accepts a limit and caps it at 100", async () => {
      const app = await createApp(db, PROJECT_ID, "userId", {
        name: "history", slug: "history", sourceType: "git", gitUrl: "https://github.com/example/repo",
      })
      for (let i = 0; i < 105; i++) await insertDeployment(app.id, "stopped")

      const list = async (args: Record<string, unknown>) => {
        const result = await handleTool("list_deployments", { app_id: app.id, ...args }, "userId")
        expect(result.isError).toBeUndefined()
        return JSON.parse(text(result)) as { createdAt: string }[]
      }
      expect(await list({})).toHaveLength(10)
      expect(await list({ limit: 25 })).toHaveLength(25)
      expect(await list({ limit: 1000 })).toHaveLength(100)
      const items = await list({ limit: 3 })
      expect(items[0]!.createdAt > items[1]!.createdAt).toBe(true)

      for (const limit of [0, -1, "many"]) {
        expect((await handleTool("list_deployments", { app_id: app.id, limit }, "userId")).isError).toBe(true)
      }
      expect((await handleTool("list_deployments", { app_id: app.id }, "outsiderId")).isError).toBe(true)
    })

    describe("stop_app", () => {
      const statusOf = async (id: string) =>
        (await db.selectFrom("deployments").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status

      it("stops only the live deployment, clears the URL and says how to resume", async () => {
        const app = await createApp(db, PROJECT_ID, "userId", {
          name: "demo", slug: "demo", sourceType: "git", gitUrl: "https://github.com/example/repo",
        })
        const live = await insertDeployment(app.id, "live")
        const building = await insertDeployment(app.id, "building")
        await db.updateTable("apps").set({ live_url: "https://demo.example.com" }).where("id", "=", app.id).execute()

        const result = await handleTool("stop_app", { app_id: app.id }, "userId")
        expect(result.isError).toBeUndefined()
        const body = JSON.parse(text(result))
        expect(body.stoppedDeployment).toBe(live)
        expect(body.note).toContain(`redeploy_deployment with deployment_id ${live}`)

        expect(await statusOf(live)).toBe("stopped")
        expect(await statusOf(building)).toBe("building")
        const after = JSON.parse(text(await handleTool("get_app", { app_id: app.id }, "userId")))
        expect(after.liveUrl ?? null).toBeNull()
        expect(after.liveDeployment).toBeNull()

        // Stopping again is harmless and says nothing was live.
        const again = JSON.parse(text(await handleTool("stop_app", { app_id: app.id }, "userId")))
        expect(again.stoppedDeployment).toBeNull()
      })

      it("rejects a missing app_id and denies other teams", async () => {
        const app = await createApp(db, PROJECT_ID, "userId", {
          name: "kept", slug: "kept", sourceType: "git", gitUrl: "https://github.com/example/repo",
        })
        const live = await insertDeployment(app.id, "live")

        expect(JSON.parse(text(await handleTool("stop_app", {}, "userId"))).code).toBe("VALIDATION_ERROR")
        const denied = await handleTool("stop_app", { app_id: app.id }, "outsiderId")
        expect(JSON.parse(text(denied))).toEqual({ error: "App not found or access denied", code: "NOT_FOUND" })
        expect(await statusOf(live)).toBe("live")
      })
    })

    describe("get_build_logs", () => {
      let deploymentId: string

      beforeAll(async () => {
        deploymentId = await insertDeployment(depAppId, "failed")
        const base = Date.UTC(2026, 1, 1)
        await db.insertInto("build_logs").values(
          Array.from({ length: 250 }, (_, i) => ({
            id: crypto.randomUUID(), deployment_id: deploymentId, line: `line ${i + 1}`, stream: "stdout",
            created_at: new Date(base + i).toISOString(),
          }))
        ).execute()
      })

      const logs = async (args: Record<string, unknown>) => {
        const result = await handleTool("get_build_logs", { deployment_id: deploymentId, ...args }, "userId")
        expect(result.isError).toBeUndefined()
        return text(result).split("\n")
      }

      it("returns the last 200 lines in order, with a header saying how to read further back", async () => {
        const lines = await logs({})
        expect(lines[0]).toBe("[Showing lines 51-250 of 250. For the 50 lines before these, call again with offset 200.]")
        expect(lines[1]).toBe("line 51")
        expect(lines.at(-1)).toBe("line 250")
        expect(lines).toHaveLength(201)
      })

      it("pages back with offset and returns the whole log without a header when it fits", async () => {
        const older = await logs({ offset: 200 })
        expect(older[0]).toBe("[Showing lines 1-50 of 250.]")
        expect(older.slice(1)).toEqual(Array.from({ length: 50 }, (_, i) => `line ${i + 1}`))

        const window = await logs({ lines: 10, offset: 5 })
        expect(window[0]).toBe("[Showing lines 236-245 of 250. For the 235 lines before these, call again with offset 15.]")

        const all = await logs({ lines: 5000 })
        expect(all).toHaveLength(250)
        expect(all[0]).toBe("line 1")
      })

      it("rejects invalid arguments, an offset past the start and other teams", async () => {
        for (const args of [{ lines: 0 }, { lines: "x" }, { offset: -1 }, { offset: 250 }]) {
          const result = await handleTool("get_build_logs", { deployment_id: deploymentId, ...args }, "userId")
          expect(JSON.parse(text(result)).code).toBe("VALIDATION_ERROR")
        }
        const outsider = await handleTool("get_build_logs", { deployment_id: deploymentId }, "outsiderId")
        expect(JSON.parse(text(outsider)).code).toBe("NOT_FOUND")
      })

      it("explains a deployment with no build logs", async () => {
        const empty = await insertDeployment(depAppId, "live")
        const result = await handleTool("get_build_logs", { deployment_id: empty }, "userId")
        expect(result.isError).toBeUndefined()
        expect(text(result)).toContain("No build logs found")
      })
    })
  })

  describe("webhooks", () => {
    const PROJECT_ID = "11111111-2222-3333-4444-555555555555"
    let providerRequests: Array<{ method: string; url: string }> = []

    function stubProvider(status = 201) {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        providerRequests.push({ method: init?.method ?? "GET", url: String(input) })
        return new Response(JSON.stringify({ id: 42 }), { status, headers: { "Content-Type": "application/json" } })
      }) as typeof fetch
    }

    function error(result: Awaited<ReturnType<typeof handleTool>>) {
      expect(result.isError).toBe(true)
      return JSON.parse(text(result)) as { error: string; code: string }
    }

    const storedSecret = async (id: string) => {
      const row = await db.selectFrom("webhook_secrets").select(["secret", "provider_hook_id"]).where("app_id", "=", id).executeTakeFirst()
      return row && { secret: decrypt(row.secret), hookId: row.provider_hook_id }
    }

    async function gitApp(slug: string, gitCredentialId?: string) {
      return createApp(db, PROJECT_ID, "userId", {
        name: slug, slug, sourceType: "git", gitUrl: "https://github.com/example/repo", gitCredentialId,
      })
    }

    beforeAll(async () => {
      await db.insertInto("git_credentials").values({
        id: "hookCredId", team_id: "teamId", name: "Hook token", provider: "github", type: "pat",
        encrypted_value: encrypt("ghp_token"), ssh_known_hosts: null, installation_id: null,
        connected_by_user_id: null, created_at: new Date().toISOString(),
      }).execute()
    })

    afterEach(() => {
      providerRequests = []
    })

    it("registers the webhook with the provider and never returns its secret", async () => {
      const app = await gitApp("hooked", "hookCredId")
      const before = JSON.parse(text(await handleTool("get_webhook", { app_id: app.id }, "userId")))
      expect(before).toMatchObject({ enabled: false, supported: true, webhook: null, autoRegistration: { possible: true } })

      stubProvider()
      const result = await handleTool("enable_webhook", { app_id: app.id, watch_path: "/apps/web" }, "userId")
      expect(result.isError).toBeUndefined()
      const body = JSON.parse(text(result))
      expect(body.webhook).toMatchObject({ provider: "github", watchPath: "apps/web", autoRegistered: true })
      expect(body.replaced).toBe(false)
      expect(providerRequests).toEqual([{ method: "POST", url: "https://api.github.com/repos/example/repo/hooks" }])

      const stored = await storedSecret(app.id)
      expect(stored?.hookId).toBe("42")
      expect(text(result)).not.toContain(stored!.secret)
      const status = await handleTool("get_webhook", { app_id: app.id }, "userId")
      expect(JSON.parse(text(status)).enabled).toBe(true)
      expect(text(status)).not.toContain(stored!.secret)
    })

    it("only replaces an existing webhook when asked, removing the old one from the provider", async () => {
      const app = await gitApp("rotated", "hookCredId")
      stubProvider()
      await handleTool("enable_webhook", { app_id: app.id }, "userId")
      const first = await storedSecret(app.id)
      providerRequests = []

      expect(error(await handleTool("enable_webhook", { app_id: app.id }, "userId")).code).toBe("CONFLICT")
      expect(providerRequests).toEqual([])
      expect((await storedSecret(app.id))?.secret).toBe(first!.secret)

      const replaced = await handleTool("enable_webhook", { app_id: app.id, replace: true }, "userId")
      expect(JSON.parse(text(replaced)).replaced).toBe(true)
      expect(providerRequests.map((r) => r.method)).toEqual(["DELETE", "POST"])
      expect(providerRequests[0]!.url).toEndWith("/hooks/42")
      expect((await storedSecret(app.id))?.secret).not.toBe(first!.secret)
    })

    it("hands manual setup to the user when canette can't register the webhook", async () => {
      const app = await gitApp("manual")
      const status = JSON.parse(text(await handleTool("get_webhook", { app_id: app.id }, "userId")))
      expect(status.autoRegistration.possible).toBe(false)
      expect(status.autoRegistration.reason).toContain("no Git credential")

      const result = error(await handleTool("enable_webhook", { app_id: app.id }, "userId"))
      expect(result.code).toBe("USER_ACTION_REQUIRED")
      expect(result.error).toContain("/dashboard/projects/test-project/apps/manual/settings#webhook")
      expect(await storedSecret(app.id)).toBeUndefined()
    })

    it("keeps no webhook when the provider refuses the token", async () => {
      const app = await gitApp("refused", "hookCredId")
      const realConsoleError = console.error
      console.error = () => {}
      try {
        stubProvider(403)
        const result = error(await handleTool("enable_webhook", { app_id: app.id }, "userId"))
        expect(result.code).toBe("USER_ACTION_REQUIRED")
        expect(result.error).toContain("GitHub API 403")
        expect(result.error).toContain("admin:repo_hook")
      } finally {
        console.error = realConsoleError
      }
      expect(await storedSecret(app.id)).toBeUndefined()
    })

    it("disables a webhook and says when there is nothing to disable", async () => {
      const app = await gitApp("unhooked", "hookCredId")
      stubProvider()
      await handleTool("enable_webhook", { app_id: app.id }, "userId")
      providerRequests = []

      const disabled = await handleTool("disable_webhook", { app_id: app.id }, "userId")
      expect(JSON.parse(text(disabled)).enabled).toBe(false)
      expect(providerRequests).toEqual([{ method: "DELETE", url: "https://api.github.com/repos/example/repo/hooks/42" }])
      expect(await storedSecret(app.id)).toBeUndefined()

      const again = JSON.parse(text(await handleTool("disable_webhook", { app_id: app.id }, "userId")))
      expect(again.note).toContain("nothing to do")
    })

    it("reports apps that can't have a webhook", async () => {
      const app = await createApp(db, PROJECT_ID, "userId", {
        name: "image", slug: "hook-image", sourceType: "image", imageUrl: "nginx", imageTag: "latest",
      })
      const status = JSON.parse(text(await handleTool("get_webhook", { app_id: app.id }, "userId")))
      expect(status).toMatchObject({ enabled: false, supported: false })
      expect(error(await handleTool("enable_webhook", { app_id: app.id }, "userId")).code).toBe("INVALID_SOURCE_TYPE")
    })

    it("rejects invalid arguments and denies other teams", async () => {
      const app = await gitApp("guarded", "hookCredId")
      for (const tool of ["get_webhook", "enable_webhook", "disable_webhook"]) {
        expect(error(await handleTool(tool, {}, "userId")).code).toBe("VALIDATION_ERROR")
        expect(error(await handleTool(tool, { app_id: app.id }, "outsiderId"))).toEqual({
          error: "App not found or access denied", code: "NOT_FOUND",
        })
      }
      expect(error(await handleTool("enable_webhook", { app_id: app.id, watch_path: 5 }, "userId")).code).toBe("VALIDATION_ERROR")
      expect(providerRequests).toEqual([])
    })
  })
})

describe("services/mcp registry", () => {
  it("registers every tool once, with a handler", () => {
    const names = ALL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of ALL_TOOLS) expect(typeof tool.handler).toBe("function")
  })
})

describe("services/mcp docs", () => {
  it("search_docs returns ranked sections with paths", async () => {
    const result = await handleTool("search_docs", { query: "persistent volume", limit: 3 }, "userId")
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(text(result))
    expect(body.version).toBeString()
    expect(body.results.length).toBe(3)
    expect(body.results[0].path).toBe("configuration/volumes")
    expect(body.results[0]).toHaveProperty("snippet")
  })

  it("search_docs requires a query and clamps limit", async () => {
    expect((await handleTool("search_docs", {}, "userId")).isError).toBe(true)
    const body = JSON.parse(text(await handleTool("search_docs", { query: "app", limit: 999 }, "userId")))
    expect(body.results.length).toBeLessThanOrEqual(20)
  })

  it("get_docs_page returns the page as markdown", async () => {
    const result = await handleTool("get_docs_page", { path: "configuration/canette-yaml" }, "userId")
    expect(result.isError).toBeUndefined()
    expect(text(result)).toStartWith("# canette.yaml\n")
    expect(text(result)).toContain("healthcheck")
  })

  it("get_docs_page suggests close matches for an unknown path", async () => {
    const result = await handleTool("get_docs_page", { path: "configuration/canette" }, "userId")
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("configuration/canette-yaml")
  })

  it("reports a clear error when the docs are not bundled", () => {
    const empty = createDocsIndex([])
    expect(text(searchDocsTool({ query: "volumes" }, empty))).toContain("not bundled")
    expect(text(getDocsPageTool({ path: "index" }, empty))).toContain("not bundled")
  })

  it("lists and reads docs pages as MCP resources", async () => {
    const server = buildMcpServer("userId")
    const client = new Client({ name: "test", version: "0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { resources } = await client.listResources()
    const yamlPage = resources.find((r) => r.uri === "canette-docs://configuration/canette-yaml")
    expect(yamlPage).toMatchObject({ title: "canette.yaml", mimeType: "text/markdown" })

    const read = await client.readResource({ uri: "canette-docs://configuration/canette-yaml" })
    expect((read.contents[0] as { text: string }).text).toStartWith("# canette.yaml\n")

    await expect(client.readResource({ uri: "canette-docs://nope" })).rejects.toThrow("Unknown resource")
    expect(client.getInstructions()).toContain("get_docs_page")

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search_docs", "get_docs_page", "get_canette_yaml_schema"]),
    )
    await client.close()
  })
})

describe("services/mcp canette.yaml schema", () => {
  it("get_canette_yaml_schema returns the canette.yaml schema by default", async () => {
    const result = await handleTool("get_canette_yaml_schema", {}, "userId")
    expect(result.isError).toBeUndefined()
    const schema = JSON.parse(text(result))
    expect(schema.$id).toBe("https://canette.dev/schema/canette.json")
    expect(schema.properties).toHaveProperty("healthcheck")
    expect(schema.properties.build.properties).toHaveProperty("dockerfile")
  })

  it("returns the template schema and rejects unknown files", () => {
    const schema = JSON.parse(text(getSchemaTool({ file: "canette-template.yaml" })))
    expect(schema.$id).toBe("https://canette.dev/schema/canette-template.json")
    const result = getSchemaTool({ file: "values.yaml" })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("canette-template.yaml")
  })

  it("lists and reads the schemas as MCP resources", async () => {
    const server = buildMcpServer("userId")
    const client = new Client({ name: "test", version: "0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["canette-schema://canette.json", "canette-schema://canette-template.json"]),
    )
    const read = await client.readResource({ uri: "canette-schema://canette.json" })
    const schema = JSON.parse((read.contents[0] as { text: string }).text)
    expect(schema.$id).toBe("https://canette.dev/schema/canette.json")
    await expect(client.readResource({ uri: "canette-schema://nope.json" })).rejects.toThrow("Unknown resource")
    expect(client.getInstructions()).toContain("get_canette_yaml_schema")
    await client.close()
  })
})
