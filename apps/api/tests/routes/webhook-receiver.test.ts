import { beforeAll, describe, expect, it, mock } from "bun:test"
import { createHmac } from "node:crypto"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"

process.env.ENCRYPTION_KEY ??= "00".repeat(32)

const db = createTestDb()
mock.module("../../src/db/db", () => ({ db }))
const { encrypt } = await import("../../src/utils/crypto")
const { WEBHOOK_BODY_LIMIT } = await import("../../src/middleware/body-limit")
const { webhookReceiverRouter } = await import("../../src/routes/webhook-receiver")

const APP_ID = "11111111-1111-4111-8111-111111111111"
const SECRET = "receiver-secret"

function sign(body: Uint8Array): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex")
}

describe("routes/webhook-receiver", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))
    const now = new Date().toISOString()
    await db.insertInto("apps").values({
      id: APP_ID, project_id: "projectId", name: "hooked", slug: "hooked", source_type: "git",
      deployment_type: "web", git_url: "https://github.com/acme/repo.git", git_branch: "main",
      git_credential_id: null, app_path: "", image_url: "", image_tag: "", port: 3000, schedule: null,
      position: 0, password_gate_enabled: false, canette_config: null,
      created_at: now, updated_at: now,
    }).execute()
    await db.insertInto("webhook_secrets").values({
      id: "hook", app_id: APP_ID, provider: "github", secret: encrypt(SECRET), watch_path: "",
      provider_hook_id: null, verified_at: now, created_at: now,
    }).execute()
  })

  it("rejects a delivery for an unknown app without reading its body", async () => {
    // An endless body: reading it would run into the 25 MiB limit. A stream
    // always pulls a chunk or two up front, so count chunks instead.
    let pulls = 0
    const body = new ReadableStream({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    const res = await webhookReceiverRouter.request("/app/22222222-2222-4222-8222-222222222222", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit)
    expect(res.status).toBe(404)
    expect(pulls).toBeLessThan(3)
  })

  it("rejects a body over the webhook limit with 413", async () => {
    const res = await webhookReceiverRouter.request(`/app/${APP_ID}`, {
      method: "POST",
      body: new Uint8Array(WEBHOOK_BODY_LIMIT + 1),
    })
    expect(res.status).toBe(413)
  })

  it("validates the HMAC over the exact bytes of a body within the limit", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ zen: "Keep it logically awesome.", pad: "x".repeat(2 * 1024 * 1024) }))
    const headers = { "x-github-event": "ping", "content-type": "application/json" }

    const ok = await webhookReceiverRouter.request(`/app/${APP_ID}`, {
      method: "POST", body, headers: { ...headers, "x-hub-signature-256": sign(body) },
    })
    expect(ok.status).toBe(200)

    const tampered = await webhookReceiverRouter.request(`/app/${APP_ID}`, {
      method: "POST", body, headers: { ...headers, "x-hub-signature-256": sign(new TextEncoder().encode("other")) },
    })
    expect(tampered.status).toBe(401)
  })
})
