import { beforeAll, describe, expect, it } from "bun:test"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { createApp } from "../../src/services/apps"
import { listEnvVars, upsertEnvVar } from "../../src/services/env-vars"
import { listSecrets, upsertSecret } from "../../src/services/secrets"
import { ServiceError } from "../../src/services/errors"

const db = createTestDb()

describe("services/secrets", () => {
  let appId: string

  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))
    const now = new Date().toISOString()
    await db.insertInto("user").values({
      id: "userId", name: "Test User", email: "test@example.com",
      emailVerified: false, image: null, role: "developer", createdAt: now, updatedAt: now,
    }).execute()
    await db.insertInto("teams").values({
      id: "teamId", name: "Test Team", is_personal: true, owner_id: "userId", created_at: now, updated_at: now,
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

  it("creates and replaces a secret without exposing its value", async () => {
    const created = await upsertSecret(db, appId, "API_KEY", "first")
    const replaced = await upsertSecret(db, appId, "API_KEY", "second")
    expect(replaced.id).toBe(created.id)
    expect(replaced).not.toHaveProperty("encryptedValue")

    const row = await db.selectFrom("secrets").select("encrypted_value").where("id", "=", created.id).executeTakeFirstOrThrow()
    expect(row.encrypted_value).not.toContain("second")
  })

  it("rejects invalid and reserved keys", async () => {
    for (const key of ["lower", "1ABC", "PORT"]) {
      await expect(upsertSecret(db, appId, key, "x")).rejects.toBeInstanceOf(ServiceError)
    }
  })

  it("refuses to shadow a plain env var unless asked to convert it", async () => {
    await upsertEnvVar(db, appId, "DATABASE_URL", "postgres://plain")

    const refused = upsertSecret(db, appId, "DATABASE_URL", "postgres://secret")
    await expect(refused).rejects.toMatchObject({ status: 409, code: "CONFLICT" })
    expect((await listSecrets(db, appId)).map((s) => s.key)).not.toContain("DATABASE_URL")

    await upsertSecret(db, appId, "DATABASE_URL", "postgres://secret", { replaceEnvVar: true })
    expect((await listSecrets(db, appId)).map((s) => s.key)).toContain("DATABASE_URL")
    expect((await listEnvVars(db, appId)).map((v) => v.key)).not.toContain("DATABASE_URL")
  })
})
