import { beforeAll, describe, it, expect } from "vitest"
import { Database } from "bun:sqlite"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createTestAuth() {
  const db = new Database(":memory:")
  return betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-long-enough-for-validation",
    database: db,
    emailAndPassword: { enabled: true },
    advanced: {
      database: {
        generateId: "uuid",
      },
    },
  })
}

describe("auth", () => {
  let auth: ReturnType<typeof createTestAuth>

  beforeAll(async () => {
    auth = createTestAuth()
    const { runMigrations } = await getMigrations(auth.options)
    await runMigrations()
  })

  it("generates UUID-format IDs for new users", async () => {
    const res = await auth.api.signUpEmail({
      body: {
        name: "Test User",
        email: "test@example.com",
        password: "password123456",
      },
    })

    expect(res.user.id).toMatch(UUID_RE)
  })
})
