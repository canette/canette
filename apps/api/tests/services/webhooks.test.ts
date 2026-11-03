import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"

process.env.ENCRYPTION_KEY ??= "00".repeat(32)

const { encrypt } = await import("../../src/utils/crypto")
const { createWebhook, deleteWebhook } = await import("../../src/services/webhooks")

const db = createTestDb()
const realFetch = globalThis.fetch
const realConsoleError = console.error
const originalAllowedOrigins = process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS
let requests: Array<{ url: string; init?: RequestInit }> = []

function stubProviderApi(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    return new Response(JSON.stringify({ id: 42 }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}

async function insertCredential(input: {
  id: string
  provider: "github" | "gitlab" | "gitea"
  type?: "pat" | "github_app"
  encryptedValue?: string
}): Promise<void> {
  await db.insertInto("git_credentials").values({
    id: input.id,
    team_id: "teamId",
    name: input.id,
    provider: input.provider,
    type: input.type ?? "pat",
    encrypted_value: input.encryptedValue ?? encrypt("test-token"),
    ssh_known_hosts: null,
    installation_id: input.type === "github_app" ? "123" : null,
    connected_by_user_id: null,
    created_at: new Date().toISOString(),
  }).execute()
}

async function insertApp(id: string, gitUrl: string, credentialId: string): Promise<void> {
  const now = new Date().toISOString()
  await db.insertInto("apps").values({
    id,
    project_id: "projectId",
    name: id,
    slug: id,
    source_type: "git",
    deployment_type: "web",
    git_url: gitUrl,
    git_branch: "main",
    git_credential_id: credentialId,
    app_path: "",
    image_url: "",
    image_tag: "",
    port: 3000,
    schedule: null,
    position: 0,
    password_gate_enabled: false,
    live_url: null,
    canette_config: null,
    runtime_health: "unknown",
    runtime_health_reason: null,
    runtime_health_updated_at: null,
    created_at: now,
    updated_at: now,
  }).execute()
}

describe("services/webhooks credential destination binding", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))
    const now = new Date().toISOString()
    await db.insertInto("user").values({
      id: "userId",
      name: "Test User",
      email: "webhooks@example.com",
      emailVerified: false,
      image: null,
      role: "developer",
      createdAt: now,
      updatedAt: now,
    }).execute()
    await db.insertInto("teams").values({
      id: "teamId",
      name: "Test Team",
      is_personal: true,
      owner_id: "userId",
      created_at: now,
      updated_at: now,
    }).execute()
    await db.insertInto("team_members").values({
      id: "memberId",
      team_id: "teamId",
      user_id: "userId",
      created_at: now,
    }).execute()
    await db.insertInto("projects").values({
      id: "projectId",
      team_id: "teamId",
      name: "Test Project",
      slug: "test-project",
      description: null,
      created_by: "userId",
      created_at: now,
      updated_at: now,
    }).execute()
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    console.error = realConsoleError
    requests = []
    if (originalAllowedOrigins === undefined) {
      delete process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS
    } else {
      process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS = originalAllowedOrigins
    }
    await db.deleteFrom("webhook_secrets").execute()
    await db.deleteFrom("apps").execute()
    await db.deleteFrom("git_credentials").execute()
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await db.destroy()
  })

  it("rejects a GitHub App credential for a caller-chosen non-GitHub host before token generation", async () => {
    await insertCredential({ id: "github-app", provider: "github", type: "github_app" })
    await insertApp("malicious-github-app", "https://attacker.example/acme/repo.git", "github-app")
    stubProviderApi()
    let errorCalls = 0
    console.error = () => { errorCalls++ }

    const result = await createWebhook(db, "malicious-github-app", "userId", { watchPath: "" })

    expect(result.autoRegistered).toBe(false)
    expect(requests).toHaveLength(0)
    expect(errorCalls).toBe(0)
  })

  it("rejects a provider-matched PAT when the caller-chosen origin is not approved", async () => {
    await insertCredential({ id: "gitlab-pat", provider: "gitlab", encryptedValue: "not-encrypted" })
    await insertApp("malicious-gitlab", "https://gitlab.attacker.example/acme/repo.git", "gitlab-pat")
    stubProviderApi()
    let errorCalls = 0
    console.error = () => { errorCalls++ }

    const result = await createWebhook(db, "malicious-gitlab", "userId", { watchPath: "" })

    expect(result.autoRegistered).toBe(false)
    expect(requests).toHaveLength(0)
    expect(errorCalls).toBe(0)
  })

  it("keeps canonical GitHub webhook registration working with bounded, non-redirecting requests", async () => {
    await insertCredential({ id: "github-pat", provider: "github" })
    await insertApp("github-app", "https://github.com/canette/example.git", "github-pat")
    stubProviderApi()

    const result = await createWebhook(db, "github-app", "userId", { watchPath: "src" })

    expect(result.autoRegistered).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.github.com/repos/canette/example/hooks")
    expect(requests[0]!.init?.redirect).toBe("error")
    expect(requests[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe("Bearer test-token")
  })

  it("allows an explicitly allowlisted self-hosted Gitea origin", async () => {
    process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS = "https://gitea.example.com:3443"
    await insertCredential({ id: "gitea-pat", provider: "gitea" })
    await insertApp("gitea-app", "https://gitea.example.com:3443/acme/repo.git", "gitea-pat")
    stubProviderApi()

    const result = await createWebhook(db, "gitea-app", "userId", { watchPath: "" })

    expect(result.autoRegistered).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://gitea.example.com:3443/api/v1/repos/acme/repo/hooks")
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe("token test-token")
  })

  it("does not send a credential during deregistration when the stored destination is unsafe", async () => {
    await insertCredential({ id: "unsafe-delete-pat", provider: "gitlab" })
    await insertApp("unsafe-delete", "https://gitlab.attacker.example/acme/repo.git", "unsafe-delete-pat")
    await db.insertInto("webhook_secrets").values({
      id: "unsafe-delete-hook",
      app_id: "unsafe-delete",
      provider: "gitlab",
      secret: encrypt("webhook-secret"),
      watch_path: "",
      provider_hook_id: "123",
      verified_at: null,
      created_at: new Date().toISOString(),
    }).execute()
    stubProviderApi()

    expect(await deleteWebhook(db, "unsafe-delete", "userId")).toBe(true)
    expect(requests).toHaveLength(0)
  })
})
