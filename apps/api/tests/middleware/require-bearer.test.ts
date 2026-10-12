import { beforeAll, describe, expect, it, mock } from "bun:test"
import { join } from "path"
import { Hono } from "hono"
import { SignJWT } from "jose"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"

process.env.MCP_JWT_SECRET = "test-secret"

const db = createTestDb()

// requireBearer reads the module-level db — point it at the in-memory test db.
mock.module("../../src/db/db", () => ({ db }))
const { requireBearer } = await import("../../src/middleware/require-bearer")
const { issueAccessToken, jwtSecret } = await import("../../src/services/oauth")

const app = new Hono().use("*", requireBearer).get("/", (c) => c.json({ userId: c.get("mcpUserId" as never) }))

function call(token?: string) {
  return app.request("/", { headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

async function addSession(id: string, userId: string, expiresAt: Date) {
  const now = new Date().toISOString()
  await db.insertInto("session").values({
    id, userId, token: `token-${id}`, expiresAt: expiresAt.toISOString(),
    createdAt: now, updatedAt: now, ipAddress: null, userAgent: null,
  }).execute()
}

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000)

describe("middleware/requireBearer", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))
    const now = new Date().toISOString()
    for (const id of ["userId", "otherUserId", "bannedUserId"]) {
      await db.insertInto("user").values({
        id, name: id, email: `${id}@example.com`, emailVerified: false, image: null,
        role: "developer", banned: id === "bannedUserId", createdAt: now, updatedAt: now,
      }).execute()
    }
  })

  it("accepts a token whose session is active", async () => {
    await addSession("active", "userId", inOneHour())
    const res = await call(await issueAccessToken("userId", "active"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: "userId" })
  })

  it("rejects a missing or malformed token", async () => {
    expect((await call()).status).toBe(401)
    expect((await call("not-a-jwt")).status).toBe(401)
  })

  it("rejects a token once its session is gone (sign-out, ban, user deletion)", async () => {
    await addSession("signed-out", "userId", inOneHour())
    const token = await issueAccessToken("userId", "signed-out")
    expect((await call(token)).status).toBe(200)

    await db.deleteFrom("session").where("id", "=", "signed-out").execute()
    expect((await call(token)).status).toBe(401)
  })

  it("rejects a token whose session has expired", async () => {
    await addSession("expired", "userId", new Date(Date.now() - 1000))
    expect((await call(await issueAccessToken("userId", "expired"))).status).toBe(401)
  })

  it("rejects a token for a banned user even if a session row remains", async () => {
    await addSession("banned", "bannedUserId", inOneHour())
    expect((await call(await issueAccessToken("bannedUserId", "banned"))).status).toBe(401)
  })

  it("rejects a token that names another user's session", async () => {
    await addSession("theirs", "otherUserId", inOneHour())
    expect((await call(await issueAccessToken("userId", "theirs"))).status).toBe(401)
  })

  it("rejects a token issued without a session binding", async () => {
    const legacy = await new SignJWT({ sub: "userId" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(jwtSecret())
    expect((await call(legacy)).status).toBe(401)
  })
})
