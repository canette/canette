import { beforeAll, describe, it, expect } from "vitest";
import { ServiceError } from "../../src/services/errors"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"

const db = createTestDb()

import { createApp, updateApp } from "../../src/services/apps";

describe("services/apps", () => {

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
      is_personal: true,
      owner_id: "userId",
      created_at: now,
      updated_at: now,
    }).execute()

    // A second team the user does not belong to
    await db.insertInto("teams").values({
      id: "otherTeamId",
      name: "Other Team",
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

    await db.insertInto("git_credentials").values([
      {
        id: "teamCredentialId",
        team_id: "teamId",
        name: "Team credential",
        provider: "github",
        type: "pat",
        encrypted_value: "enc:placeholder",
        ssh_known_hosts: null,
        created_at: now,
      },
      {
        id: "otherTeamCredentialId",
        team_id: "otherTeamId",
        name: "Other team credential",
        provider: "github",
        type: "pat",
        encrypted_value: "enc:placeholder",
        ssh_known_hosts: null,
        created_at: now,
      },
      {
        id: "systemCredentialId",
        team_id: null,
        name: "System credential",
        provider: "github",
        type: "github_app",
        encrypted_value: "enc:placeholder",
        ssh_known_hosts: null,
        created_at: now,
      },
    ]).execute()

    // Pre-existing app used by updateApp tests
    await db.insertInto("apps").values({
      id: "existingAppId",
      project_id: "projectId",
      name: "Existing App",
      slug: "existing-app",
      source_type: "git",
      git_url: "https://github.com/canette/canette",
      git_branch: "main",
      git_credential_id: null,
      app_path: "",
      image_url: "",
      image_tag: "",
      port: 3000,
      live_url: null,
      canette_config: null,
      created_at: now,
      updated_at: now,
    }).execute()
  })

  it("createApp: happy path", async () => {
    const result = await createApp(
      db,
      "projectId",
      "userId",
      {
        name: "My App",
        slug: "slug1",
        sourceType: "git",
        gitUrl: "https://github.com/canette/canette",
        gitBranch: "main",
        gitCredentialId: "teamCredentialId",
      }
    );

    expect(result).toMatchObject({ name: "My App", slug: "slug1" });
  });

  it("createApp: system credentials", async () => {
    const result = await createApp(
      db,
      "projectId",
      "userId",
      {
        name: "My App",
        slug: "slug2",
        sourceType: "git",
        gitUrl: "https://github.com/canette/canette",
        gitBranch: "main",
        gitCredentialId: "systemCredentialId",
      }
    );

    expect(result).toMatchObject({ name: "My App", slug: "slug2" });
  });

  it("createApp: rejects credential belonging to another team", async () => {
    await expect(
      createApp(db, "projectId", "userId", {
        name: "My App",
        slug: "slug3",
        sourceType: "git",
        gitUrl: "https://github.com/canette/canette",
        gitBranch: "main",
        gitCredentialId: "otherTeamCredentialId",
      })
    ).rejects.toThrow(ServiceError)
  })

  describe("deploymentType", () => {
    it("createApp: defaults to 'web' when omitted", async () => {
      const result = await createApp(db, "projectId", "userId", {
        name: "Deployment Type Default",
        slug: "dt-default",
        sourceType: "git",
        gitUrl: "https://github.com/canette/canette",
      })
      expect(result.deploymentType).toBe("web")
    })

    it("createApp: stores 'private' when specified", async () => {
      const result = await createApp(db, "projectId", "userId", {
        name: "Private App",
        slug: "dt-private",
        sourceType: "git",
        gitUrl: "https://github.com/canette/canette",
        deploymentType: "private",
      })
      expect(result.deploymentType).toBe("private")
    })

    it("updateApp: can change deploymentType from 'web' to 'private'", async () => {
      const created = await createApp(db, "projectId", "userId", {
        name: "Update DT App",
        slug: "dt-update",
        sourceType: "git",
        gitUrl: "https://github.com/canette/canette",
      })
      expect(created.deploymentType).toBe("web")
      const updated = await updateApp(db, created.id, "userId", { deploymentType: "private" })
      expect(updated?.deploymentType).toBe("private")
    })

    it("createApp: rejects invalid deploymentType", async () => {
      await expect(
        createApp(db, "projectId", "userId", {
          name: "Bad DT App",
          slug: "dt-bad",
          sourceType: "git",
          gitUrl: "https://github.com/canette/canette",
          deploymentType: "invalid" as never,
        })
      ).rejects.toThrow(ServiceError)
    })
  })

  describe("updateApp", () => {
    it("accepts credential belonging to the same team", async () => {
      const result = await updateApp(db, "existingAppId", "userId", {
        gitCredentialId: "teamCredentialId",
      })
      expect(result).toMatchObject({ gitCredentialId: "teamCredentialId" })
    })

    it("accepts a system credential", async () => {
      const result = await updateApp(db, "existingAppId", "userId", {
        gitCredentialId: "systemCredentialId",
      })
      expect(result).toMatchObject({ gitCredentialId: "systemCredentialId" })
    })

    it("rejects a credential belonging to another team", async () => {
      await expect(
        updateApp(db, "existingAppId", "userId", {
          gitCredentialId: "otherTeamCredentialId",
        })
      ).rejects.toThrow(ServiceError)
    })

    it("accepts null to clear the credential", async () => {
      const before = await updateApp(db, "existingAppId", "userId", {
          gitCredentialId: "systemCredentialId",
      })
      expect(before).toMatchObject({ gitCredentialId: "systemCredentialId" })

      const result = await updateApp(db, "existingAppId", "userId", {
        gitCredentialId: null,
      })
      expect(result).toMatchObject({ gitCredentialId: undefined })
    })
  })
});
