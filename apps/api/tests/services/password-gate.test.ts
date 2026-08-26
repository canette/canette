import { beforeAll, describe, it, expect } from "vitest"
import { password } from "bun"
import { ServiceError } from "../../src/services/errors"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { createApp } from "../../src/services/apps"
import {
  AUTHGATE_SIDECAR_PORT,
  disablePasswordGate,
  enablePasswordGate,
  getPasswordGateStatus,
} from "../../src/services/password-gate"

const db = createTestDb()

describe("services/password-gate", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))

    const now = new Date().toISOString()

    await db.insertInto("user").values({
      id: "userId", name: "Test User", email: "test@example.com",
      emailVerified: false, image: null, role: "developer",
      createdAt: now, updatedAt: now,
    }).execute()

    await db.insertInto("teams").values({
      id: "teamId", name: "Test Team", is_personal: true, owner_id: "userId",
      created_at: now, updated_at: now,
    }).execute()

    await db.insertInto("team_members").values({
      id: "memberId", team_id: "teamId", user_id: "userId", created_at: now,
    }).execute()

    await db.insertInto("projects").values({
      id: "projId", team_id: "teamId", name: "Test Project", slug: "test-project",
      description: null, created_by: "userId", created_at: now, updated_at: now,
    }).execute()
  })

  async function makeApp(slug: string, deploymentType: "web" | "private" | "cronjob" = "web") {
    return createApp(db, "projId", "userId", {
      name: slug, slug, sourceType: "git", gitUrl: "https://github.com/example/repo",
      deploymentType,
      schedule: deploymentType === "cronjob" ? "* * * * *" : undefined,
    })
  }

  it("reports disabled initially", async () => {
    const app = await makeApp("gate-status-app")
    expect(await getPasswordGateStatus(db, app.id, "userId")).toEqual({ enabled: false })
  })

  it("enables the gate on a web app and never returns the hash", async () => {
    const app = await makeApp("gate-enable-app")
    const status = await enablePasswordGate(db, app.id, "userId", { password: "hunter22" })
    expect(status).toEqual({ enabled: true })
    expect(status).not.toHaveProperty("password")
    expect(status).not.toHaveProperty("passwordHash")

    expect(await getPasswordGateStatus(db, app.id, "userId")).toEqual({ enabled: true })
  })

  it("stores a bcrypt hash that verifies the original password", async () => {
    const app = await makeApp("gate-hash-app")
    await enablePasswordGate(db, app.id, "userId", { password: "correct-horse" })

    const row = await db
      .selectFrom("apps")
      .select(["password_gate_password_hash"])
      .where("id", "=", app.id)
      .executeTakeFirstOrThrow()
    expect(row.password_gate_password_hash).toBeTruthy()
    expect(await password.verify("correct-horse", row.password_gate_password_hash!)).toBe(true)
    expect(await password.verify("wrong-password", row.password_gate_password_hash!)).toBe(false)
  })

  it("rejects enabling the gate on non-web apps", async () => {
    const privateApp = await makeApp("gate-private-app", "private")
    await expect(enablePasswordGate(db, privateApp.id, "userId", { password: "b" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 422,
    })

    const cronApp = await makeApp("gate-cron-app", "cronjob")
    await expect(enablePasswordGate(db, cronApp.id, "userId", { password: "b" })).rejects.toMatchObject({
      status: 422,
    })
  })

  it("rejects empty or overlong passwords", async () => {
    const app = await makeApp("gate-password-app")
    await expect(enablePasswordGate(db, app.id, "userId", { password: "" })).rejects.toThrow(ServiceError)
    await expect(
      enablePasswordGate(db, app.id, "userId", { password: "a".repeat(73) })
    ).rejects.toThrow(ServiceError)
    // Exactly at the limit is fine.
    await expect(
      enablePasswordGate(db, app.id, "userId", { password: "a".repeat(72) })
    ).resolves.toMatchObject({ enabled: true })
  })

  it("re-enabling replaces the password", async () => {
    const app = await makeApp("gate-replace-app")
    await enablePasswordGate(db, app.id, "userId", { password: "first-pass" })
    const status = await enablePasswordGate(db, app.id, "userId", { password: "second-pass" })
    expect(status).toEqual({ enabled: true })

    const row = await db
      .selectFrom("apps")
      .select(["password_gate_password_hash"])
      .where("id", "=", app.id)
      .executeTakeFirstOrThrow()
    expect(await password.verify("second-pass", row.password_gate_password_hash!)).toBe(true)
    expect(await password.verify("first-pass", row.password_gate_password_hash!)).toBe(false)
  })

  it("disables the gate and clears stored credentials", async () => {
    const app = await makeApp("gate-disable-app")
    await enablePasswordGate(db, app.id, "userId", { password: "x".repeat(10) })
    const status = await disablePasswordGate(db, app.id, "userId")
    expect(status).toEqual({ enabled: false })
    expect(await getPasswordGateStatus(db, app.id, "userId")).toEqual({ enabled: false })

    const row = await db
      .selectFrom("apps")
      .select(["password_gate_password_hash"])
      .where("id", "=", app.id)
      .executeTakeFirstOrThrow()
    expect(row.password_gate_password_hash).toBeNull()
  })

  it("404s for an app the caller has no team access to", async () => {
    await expect(getPasswordGateStatus(db, "does-not-exist", "userId")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    })
    await expect(
      enablePasswordGate(db, "does-not-exist", "userId", { password: "b" })
    ).rejects.toMatchObject({ status: 404 })
    await expect(disablePasswordGate(db, "does-not-exist", "userId")).rejects.toMatchObject({ status: 404 })
  })

  it("rejects the sidecar's reserved port on app create/update", async () => {
    await expect(
      createApp(db, "projId", "userId", {
        name: "gate-port-app", slug: "gate-port-app", sourceType: "git",
        gitUrl: "https://github.com/example/repo", port: AUTHGATE_SIDECAR_PORT,
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
  })
})
