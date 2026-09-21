import { beforeAll, describe, it, expect } from "vitest"
import { Database } from "bun:sqlite"
import { Kysely, SqliteDialect } from "kysely"
import { join } from "path"
import { betterAuth } from "better-auth"
import { coreAuthOptions } from "../../src/auth/auth"
import { PASSWORD_REQUIREMENTS } from "../../src/auth/password"
import { runMigrations } from "../../src/db/migrations"
import type { Database as DB } from "../../src/db/types"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Schema is provisioned from the repo's own hand-written migrations (the
// same ones Postgres runs in prod) rather than better-auth's `getMigrations`,
// which derives a schema straight from the plugin config and will happily
// "pass" even when the checked-in migrations have drifted from what the
// configured plugins (admin, magicLink, genericOAuth, ...) actually require.
// That drift is exactly what caused a runtime `SCHEMA_MISMATCH` in prod when
// better-auth started enforcing this at startup — see migration 000017.
function createTestAuth(rawDb: Database) {
  return betterAuth({
    ...coreAuthOptions,
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-long-enough-for-validation",
    database: rawDb,
  })
}

describe("auth", () => {
  let auth: ReturnType<typeof createTestAuth>

  beforeAll(async () => {
    const rawDb = new Database(":memory:")
    const shim = {
      prepare(sql: string) {
        const stmt = rawDb.prepare(sql)
        return Object.assign(stmt, { reader: /^\s*SELECT\b/i.test(sql) })
      },
      close() {
        rawDb.close()
      },
    }
    const kysely = new Kysely<DB>({ dialect: new SqliteDialect({ database: shim as never }) })
    await runMigrations(kysely, join(import.meta.dir, "../../migrations"))

    auth = createTestAuth(rawDb)
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
