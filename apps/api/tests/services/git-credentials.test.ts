import { beforeAll, describe, it, expect } from "vitest"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"
import { upsertGithubAppInstallation, listTeamCredentials, listLinkableInstallations, linkInstallationToTeam } from "../../src/services/git-credentials"
import { ServiceError } from "../../src/services/errors"

const db = createTestDb()

describe("services/git-credentials", () => {

  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))

    const now = new Date().toISOString()

    await db.insertInto("user").values([
      { id: "userId", name: "Test User", email: "test@example.com", emailVerified: false, image: null, role: "developer", createdAt: now, updatedAt: now },
      { id: "otherUserId", name: "Other User", email: "other@example.com", emailVerified: false, image: null, role: "developer", createdAt: now, updatedAt: now },
    ]).execute()

    await db.insertInto("teams").values([
      { id: "teamId", name: "Test Team", is_personal: false, owner_id: "userId", created_at: now, updated_at: now },
      { id: "teamBId", name: "Team B", is_personal: false, owner_id: "userId", created_at: now, updated_at: now },
      { id: "teamCId", name: "Team C (other owner)", is_personal: false, owner_id: "otherUserId", created_at: now, updated_at: now },
    ]).execute()

    await db.insertInto("team_members").values([
      { id: "memberId", team_id: "teamId", user_id: "userId", created_at: now },
      { id: "memberBId", team_id: "teamBId", user_id: "userId", created_at: now },
      { id: "memberCOther", team_id: "teamCId", user_id: "otherUserId", created_at: now },
      // userId is also a member of teamCId (shared team)
      { id: "memberCUser", team_id: "teamCId", user_id: "userId", created_at: now },
    ]).execute()
  })

  describe("upsertGithubAppInstallation", () => {
    it("creates a new github_app credential for the team", async () => {
      const cred = await upsertGithubAppInstallation(db, "teamId", "111", "myorg", "userId")
      expect(cred.type).toBe("github_app")
      expect(cred.provider).toBe("github")
      expect(cred.name).toBe("myorg")
      expect(cred.installationId).toBe("111")
      expect(cred.teamId).toBe("teamId")
    })

    it("stores connected_by_user_id on insert", async () => {
      await upsertGithubAppInstallation(db, "teamId", "inst-ownership", "ownership-org", "userId")
      const row = await db.selectFrom("git_credentials").selectAll()
        .where("installation_id", "=", "inst-ownership").executeTakeFirst()
      expect(row?.connected_by_user_id).toBe("userId")
    })

    it("updates name when called again with the same installation_id but does not change connected_by_user_id", async () => {
      await upsertGithubAppInstallation(db, "teamId", "222", "original-org", "userId")
      const updated = await upsertGithubAppInstallation(db, "teamId", "222", "renamed-org", "otherUserId")
      expect(updated.name).toBe("renamed-org")
      expect(updated.installationId).toBe("222")
      // connected_by_user_id must not have been overwritten
      const row = await db.selectFrom("git_credentials").selectAll()
        .where("installation_id", "=", "222").where("team_id", "=", "teamId").executeTakeFirst()
      expect(row?.connected_by_user_id).toBe("userId")
    })

    it("does not create a duplicate when called twice with same installation_id", async () => {
      await upsertGithubAppInstallation(db, "teamId", "333", "org-a", "userId")
      await upsertGithubAppInstallation(db, "teamId", "333", "org-a", "userId")
      const all = await db.selectFrom("git_credentials").selectAll()
        .where("team_id", "=", "teamId").where("installation_id", "=", "333").execute()
      expect(all.length).toBe(1)
    })

    it("allows multiple installations with different installation_ids on the same team", async () => {
      await upsertGithubAppInstallation(db, "teamId", "444", "org-one", "userId")
      await upsertGithubAppInstallation(db, "teamId", "555", "org-two", "userId")
      const all = await db.selectFrom("git_credentials").selectAll()
        .where("team_id", "=", "teamId").where("installation_id", "in", ["444", "555"]).execute()
      expect(all.length).toBe(2)
    })
  })

  describe("listTeamCredentials", () => {
    it("includes installationId in the response for github_app credentials", async () => {
      await upsertGithubAppInstallation(db, "teamId", "999", "listed-org", "userId")
      const creds = await listTeamCredentials(db, "teamId", "userId")
      const appCred = creds?.find((c) => c.installationId === "999")
      expect(appCred).toBeDefined()
      expect(appCred?.type).toBe("github_app")
      expect(appCred?.name).toBe("listed-org")
    })

    it("returns null when user is not a team member", async () => {
      const result = await listTeamCredentials(db, "teamId", "nonexistent-user")
      expect(result).toBeNull()
    })
  })

  describe("listLinkableInstallations", () => {
    beforeAll(async () => {
      // userId connected inst-link-A on teamId, inst-link-B on teamBId
      await upsertGithubAppInstallation(db, "teamId", "inst-link-A", "link-org-A", "userId")
      await upsertGithubAppInstallation(db, "teamBId", "inst-link-B", "link-org-B", "userId")
      // otherUserId connected inst-link-C on teamCId (userId is also a member of teamCId)
      await upsertGithubAppInstallation(db, "teamCId", "inst-link-C", "link-org-C", "otherUserId")
    })

    it("returns installations the user personally connected on other teams", async () => {
      // From teamBId's perspective: userId connected inst-link-A on teamId
      const result = await listLinkableInstallations(db, "teamBId", "userId")
      const ids = result.map((r) => r.installationId)
      expect(ids).toContain("inst-link-A")
    })

    it("excludes installations connected by a different user even on a shared team", async () => {
      // userId is a member of teamCId but did NOT connect inst-link-C (otherUserId did)
      const result = await listLinkableInstallations(db, "teamBId", "userId")
      const ids = result.map((r) => r.installationId)
      expect(ids).not.toContain("inst-link-C")
    })

    it("excludes installations already linked to the target team", async () => {
      // inst-link-A is already on teamId — should not appear when querying from teamId
      const result = await listLinkableInstallations(db, "teamId", "userId")
      const ids = result.map((r) => r.installationId)
      expect(ids).not.toContain("inst-link-A")
    })

    it("returns empty array when caller is not a member of teamId", async () => {
      const result = await listLinkableInstallations(db, "teamId", "nonexistent-user")
      expect(result).toEqual([])
    })

    it("deduplicates when same installationId appears in multiple teams connected by the same user", async () => {
      // Link inst-link-A to teamBId as well (same user)
      await upsertGithubAppInstallation(db, "teamBId", "inst-link-A", "link-org-A", "userId")
      // Now from teamId's perspective, inst-link-A is on teamBId — should appear only once
      const result = await listLinkableInstallations(db, "teamId", "userId")
      const matchingA = result.filter((r) => r.installationId === "inst-link-A")
      expect(matchingA.length).toBeLessThanOrEqual(1)
    })
  })

  describe("linkInstallationToTeam", () => {
    beforeAll(async () => {
      // userId connected inst-to-link on teamId
      await upsertGithubAppInstallation(db, "teamId", "inst-to-link", "to-link-org", "userId")
      // otherUserId connected inst-other-link on teamCId
      await upsertGithubAppInstallation(db, "teamCId", "inst-other-link", "other-link-org", "otherUserId")
    })

    it("links an installation the user personally connected to another team they belong to", async () => {
      const cred = await linkInstallationToTeam(db, "teamBId", "userId", "inst-to-link")
      expect(cred.teamId).toBe("teamBId")
      expect(cred.installationId).toBe("inst-to-link")
      expect(cred.name).toBe("to-link-org")
    })

    it("rejects an installationId connected by a different user even if caller shares a team", async () => {
      // userId is a member of teamCId but did NOT connect inst-other-link
      await expect(
        linkInstallationToTeam(db, "teamId", "userId", "inst-other-link")
      ).rejects.toThrow(ServiceError)
    })

    it("rejects a nonexistent installationId", async () => {
      await expect(
        linkInstallationToTeam(db, "teamBId", "userId", "inst-does-not-exist")
      ).rejects.toThrow(ServiceError)
    })

    it("rejects when caller is not a member of the target team", async () => {
      await expect(
        linkInstallationToTeam(db, "nonexistent-team", "userId", "inst-to-link")
      ).rejects.toThrow(ServiceError)
    })

    it("is idempotent: re-linking returns existing credential without error", async () => {
      // inst-to-link was already linked to teamBId in the first test
      const cred = await linkInstallationToTeam(db, "teamBId", "userId", "inst-to-link")
      expect(cred.installationId).toBe("inst-to-link")
      expect(cred.teamId).toBe("teamBId")
    })
  })
})
