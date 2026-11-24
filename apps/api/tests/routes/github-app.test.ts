import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { join } from "path"
import { runMigrations } from "../../src/db/migrations"
import { createTestDb } from "../utils/sqlite"

process.env.ENCRYPTION_KEY ??= "00".repeat(32)
process.env.UI_URL = "https://canette.example.com"
process.env.GITHUB_APP_ID = "123"
process.env.GITHUB_APP_PUBLIC_LINK = "canette-test"
process.env.GITHUB_APP_CLIENT_ID = "Iv1.client"
process.env.GITHUB_APP_CLIENT_SECRET = "client-secret"
process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" }).toString()

const db = createTestDb()
mock.module("../../src/db/db", () => ({ db }))
// requireAuth: the x-test-user header stands in for a session cookie.
mock.module("../../src/auth/auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-user")
        return id ? { user: { id }, session: { id: `session-${id}` } } : null
      },
    },
  },
}))
const { githubAppRouter } = await import("../../src/routes/github-app")

const UI = "https://canette.example.com"
const CALLBACK = `${UI}/api/v1/github-app/callback`
const realFetch = globalThis.fetch

// The GitHub API as seen by the callback: the installations the user can
// access, and what the code exchange returns.
let userInstallations: number[] = []
let tokenResponse: Record<string, unknown> = { access_token: "ghu_user" }
let githubCalls: string[] = []

function stubGithub(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    githubCalls.push(url)
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body))
      if (body.code !== "good-code" || !body.code_verifier || body.redirect_uri !== CALLBACK) {
        return Response.json({ error: "bad_verification_code" })
      }
      return Response.json(tokenResponse)
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      return Response.json({ total_count: userInstallations.length, installations: userInstallations.map((id) => ({ id })) })
    }
    const match = url.match(/^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/)
    if (match) return Response.json({ id: Number(match[1]), account: { login: `org-${match[1]}`, type: "Organization" } })
    return new Response("unexpected", { status: 500 })
  }) as typeof fetch
}

async function installUrl(teamId: string, userId: string) {
  const res = await githubAppRouter.request(`/install-url?teamId=${teamId}`, { headers: { "x-test-user": userId } })
  return (await res.json()) as { available: boolean; url?: string }
}

async function startInstall(teamId = "team-a", userId = "alice"): Promise<string> {
  const { url } = await installUrl(teamId, userId)
  return new URL(url!).searchParams.get("state")!
}

// GitHub redirects the browser of the user who started the flow, so the
// callback carries their session unless a test says otherwise.
function callback(params: Record<string, string>, userId: string | null = "alice") {
  return githubAppRouter.request(`/callback?${new URLSearchParams(params)}`, {
    headers: userId ? { "x-test-user": userId } : {},
  })
}

// Runs the Setup URL step and returns the state GitHub would send back to the
// OAuth callback.
async function setupStep(installationId: string, teamId = "team-a", userId = "alice"): Promise<string> {
  const state = await startInstall(teamId, userId)
  const res = await callback({ installation_id: installationId, setup_action: "install", state }, userId)
  const location = new URL(res.headers.get("location")!)
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize")
  return location.searchParams.get("state")!
}

async function credentialsFor(teamId: string) {
  return db.selectFrom("git_credentials").select(["installation_id", "connected_by_user_id"])
    .where("team_id", "=", teamId).execute()
}

describe("routes/github-app", () => {
  beforeAll(async () => {
    await runMigrations(db, join(import.meta.dir, "../../migrations"))
    const now = new Date().toISOString()
    for (const id of ["alice", "bob"]) {
      await db.insertInto("user").values({
        id, name: id, email: `${id}@example.com`, emailVerified: false, image: null,
        role: "developer", createdAt: now, updatedAt: now,
      }).execute()
    }
    await db.insertInto("teams").values({
      id: "team-a", name: "Team A", is_personal: false, owner_id: "alice", created_at: now, updated_at: now,
    }).execute()
    await db.insertInto("team_members").values([
      { id: "m-alice", team_id: "team-a", user_id: "alice", created_at: now },
      { id: "m-bob", team_id: "team-a", user_id: "bob", created_at: now },
    ]).execute()
  })

  beforeEach(() => {
    userInstallations = []
    tokenResponse = { access_token: "ghu_user" }
    githubCalls = []
    stubGithub()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  describe("GET /install-url", () => {
    it("is unavailable without the App's OAuth client", async () => {
      delete process.env.GITHUB_APP_CLIENT_SECRET
      try {
        expect(await installUrl("team-a", "alice")).toEqual({ available: false })
      } finally {
        process.env.GITHUB_APP_CLIENT_SECRET = "client-secret"
      }
    })

    it("returns an install URL with an opaque state for a team member", async () => {
      const { available, url } = await installUrl("team-a", "alice")
      expect(available).toBe(true)
      expect(url).toStartWith("https://github.com/apps/canette-test/installations/new?state=")
    })
  })

  describe("GET /callback", () => {
    it("sends the Setup URL step through GitHub's OAuth flow with PKCE, storing nothing yet", async () => {
      const state = await startInstall()
      const res = await callback({ installation_id: "1001", setup_action: "install", state })

      const location = new URL(res.headers.get("location")!)
      expect(location.searchParams.get("client_id")).toBe("Iv1.client")
      expect(location.searchParams.get("redirect_uri")).toBe(CALLBACK)
      expect(location.searchParams.get("code_challenge_method")).toBe("S256")
      expect(location.searchParams.get("state")).not.toBe(state)
      expect(await credentialsFor("team-a")).toEqual([])
    })

    it("stores the installation once the user's token can access it", async () => {
      const state = await setupStep("1002")
      userInstallations = [999, 1002]

      const res = await callback({ code: "good-code", state })
      expect(res.headers.get("location")).toBe(`${UI}/dashboard/teams/team-a?tab=credentials&github_app=installed`)
      expect(await credentialsFor("team-a")).toContainEqual({ installation_id: "1002", connected_by_user_id: "alice" })
    })

    it("rejects an installation the user cannot see in /user/installations", async () => {
      const state = await setupStep("2001")
      userInstallations = [999]

      const res = await callback({ code: "good-code", state })
      expect(res.headers.get("location")).toBe(`${UI}/dashboard/teams/team-a?tab=credentials&error=github-app-not-authorized`)
      expect((await credentialsFor("team-a")).map((c) => c.installation_id)).not.toContain("2001")
    })

    it("rejects a failed code exchange", async () => {
      const state = await setupStep("2002")
      userInstallations = [2002]

      const res = await callback({ code: "bad-code", state })
      expect(res.headers.get("location")).toContain("error=github-app-callback-failed")
      expect((await credentialsFor("team-a")).map((c) => c.installation_id)).not.toContain("2002")
    })

    it("rejects a replayed state at either step", async () => {
      const installState = await startInstall()
      await callback({ installation_id: "3001", setup_action: "install", state: installState })
      const replay = await callback({ installation_id: "3001", setup_action: "install", state: installState })
      expect(replay.headers.get("location")).toBe(`${UI}/dashboard?error=github-app-invalid-state`)

      const authorizeState = await setupStep("3002")
      userInstallations = [3002]
      await callback({ code: "good-code", state: authorizeState })
      const again = await callback({ code: "good-code", state: authorizeState })
      expect(again.headers.get("location")).toBe(`${UI}/dashboard?error=github-app-invalid-state`)
    })

    it("does not accept a state from one step at the other", async () => {
      const installState = await startInstall()
      userInstallations = [4001]
      const res = await callback({ code: "good-code", state: installState })
      expect(res.headers.get("location")).toBe(`${UI}/dashboard?error=github-app-invalid-state`)
    })

    it("rejects a user removed from the team before the callback", async () => {
      const state = await startInstall("team-a", "bob")
      await db.deleteFrom("team_members").where("id", "=", "m-bob").execute()

      const res = await callback({ installation_id: "5001", setup_action: "install", state }, "bob")
      expect(res.headers.get("location")).toBe(`${UI}/dashboard?error=github-app-not-a-member`)
      expect(githubCalls).toEqual([])
    })

    it("rejects an installation_id that is not numeric", async () => {
      for (const installationId of ["1/../../users", "abc", ""]) {
        const state = await startInstall()
        const res = await callback({ installation_id: installationId, setup_action: "install", state })
        expect(res.headers.get("location")).toContain("error=github-app-no-installation")
      }
    })

    it("reports a pending request without asking for authorization", async () => {
      const state = await startInstall()
      const res = await callback({ setup_action: "request", state })
      expect(res.headers.get("location")).toBe(`${UI}/dashboard/teams/team-a?tab=credentials&github_app=pending`)
    })

    it("rejects an authorize link opened in another user's browser", async () => {
      // Alice starts the flow for an installation she can't access and gets
      // its owner, Bob, to open the authorize link. Bob's token can access it.
      const state = await setupStep("6001")
      userInstallations = [6001]

      const res = await callback({ code: "good-code", state }, "bob")
      expect(res.headers.get("location")).toBe(`${UI}/dashboard?error=github-app-invalid-state`)
      expect(githubCalls.some((u) => u.includes("access_token"))).toBe(false)
      expect((await credentialsFor("team-a")).map((c) => c.installation_id)).not.toContain("6001")
    })

    it("rejects a callback without a canette session", async () => {
      const installState = await startInstall()
      const res = await callback({ installation_id: "6002", setup_action: "install", state: installState }, null)
      expect(res.headers.get("location")).toBe(`${UI}/dashboard?error=github-app-invalid-state`)

      const authorizeState = await setupStep("6003")
      userInstallations = [6003]
      const again = await callback({ code: "good-code", state: authorizeState }, null)
      expect(again.headers.get("location")).toBe(`${UI}/dashboard?error=github-app-invalid-state`)
    })

    it("rejects missing and unknown states", async () => {
      expect((await callback({ installation_id: "1" })).headers.get("location")).toBe(`${UI}/dashboard?error=github-app-missing-state`)
      expect((await callback({ installation_id: "1", state: "forged" })).headers.get("location")).toBe(`${UI}/dashboard?error=github-app-invalid-state`)
    })
  })
})
