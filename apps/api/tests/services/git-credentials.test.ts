import { beforeAll, describe, it, expect } from "vitest"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { upsertGithubAppInstallation, listTeamCredentials } from "../../src/services/git-credentials"

const db = createTestDb()

describe("services/git-credentials", () => {

  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))

    const now = new Date().toISOString()

    await db.insertInto("user").values({
      id: "userId",
      name: "Test User",
      email: "test@example.com",
      emailVerified: false,
      image: null,
      role: "developer",
      createdAt: now,
      updatedAt: now,
    }).execute()

    await db.insertInto("teams").values({
      id: "teamId",
      name: "Test Team",
      is_personal: false,
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
  })

  describe("upsertGithubAppInstallation", () => {
    it("creates a new github_app credential for the team", async () => {
      const cred = await upsertGithubAppInstallation(db, "teamId", "111", "myorg")
      expect(cred.type).toBe("github_app")
      expect(cred.provider).toBe("github")
      expect(cred.name).toBe("myorg (GitHub App)")
      expect(cred.installationId).toBe("111")
      expect(cred.teamId).toBe("teamId")
    })

    it("updates name when called again with the same installation_id", async () => {
      await upsertGithubAppInstallation(db, "teamId", "222", "original-org")
      const updated = await upsertGithubAppInstallation(db, "teamId", "222", "renamed-org")
      expect(updated.name).toBe("renamed-org (GitHub App)")
      expect(updated.installationId).toBe("222")
    })

    it("does not create a duplicate when called twice with same installation_id", async () => {
      await upsertGithubAppInstallation(db, "teamId", "333", "org-a")
      await upsertGithubAppInstallation(db, "teamId", "333", "org-a")
      const all = await db
        .selectFrom("git_credentials")
        .selectAll()
        .where("team_id", "=", "teamId")
        .where("installation_id", "=", "333")
        .execute()
      expect(all.length).toBe(1)
    })

    it("allows multiple installations with different installation_ids on the same team", async () => {
      await upsertGithubAppInstallation(db, "teamId", "444", "org-one")
      await upsertGithubAppInstallation(db, "teamId", "555", "org-two")
      const all = await db
        .selectFrom("git_credentials")
        .selectAll()
        .where("team_id", "=", "teamId")
        .where("installation_id", "in", ["444", "555"])
        .execute()
      expect(all.length).toBe(2)
    })
  })

  describe("listTeamCredentials", () => {
    it("includes installationId in the response for github_app credentials", async () => {
      await upsertGithubAppInstallation(db, "teamId", "999", "listed-org")
      const creds = await listTeamCredentials(db, "teamId", "userId")
      const appCred = creds?.find((c) => c.installationId === "999")
      expect(appCred).toBeDefined()
      expect(appCred?.type).toBe("github_app")
      expect(appCred?.name).toBe("listed-org (GitHub App)")
    })

    it("returns null when user is not a team member", async () => {
      const result = await listTeamCredentials(db, "teamId", "nonexistent-user")
      expect(result).toBeNull()
    })
  })
})
