import { beforeAll, describe, it, expect } from "vitest"
import { Database } from "bun:sqlite"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { coreAuthOptions } from "../../src/auth/auth"
import { PASSWORD_REQUIREMENTS } from "../../src/auth/password"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createTestAuth() {
  return betterAuth({
    ...coreAuthOptions,
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-long-enough-for-validation",
    database: new Database(":memory:"),
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
        password: "Password123456!",
      },
    })

    expect(res.user.id).toMatch(UUID_RE)
  })

  it.each([
    ["short",          "Ab1!"],
    ["no uppercase",   "password123456"],
    ["no lowercase",   "PASSWORD123456"],
    ["no number",      "PasswordABCDEF"],
  ])("rejects weak password: %s", async (_label, password) => {
    await expect(
      auth.api.signUpEmail({
        body: { name: "Test User", email: "weak@example.com", password },
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it("password requirements stay in sync with PASSWORD_REQUIREMENTS", () => {
    expect(PASSWORD_REQUIREMENTS).toContainEqual(
      expect.objectContaining({ label: expect.stringMatching(/12 characters/) }),
    )
    expect(PASSWORD_REQUIREMENTS).toContainEqual(
      expect.objectContaining({ label: expect.stringMatching(/uppercase/) }),
    )
    expect(PASSWORD_REQUIREMENTS).toContainEqual(
      expect.objectContaining({ label: expect.stringMatching(/lowercase/) }),
    )
    expect(PASSWORD_REQUIREMENTS).toContainEqual(
      expect.objectContaining({ label: expect.stringMatching(/number/) }),
    )
  })
})
