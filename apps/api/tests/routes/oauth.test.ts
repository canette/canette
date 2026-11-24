import { describe, expect, it, mock } from "bun:test"

// /deny and /register never need a session; keep the real better-auth
// instance (and its database) out of this suite.
mock.module("../../src/auth/auth", () => ({ auth: { api: { getSession: async () => null } } }))
const { oauthRouter } = await import("../../src/routes/oauth")

function register(body: unknown) {
  return oauthRouter.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function deny(params: Record<string, string>, headers: Record<string, string> = {}) {
  return oauthRouter.request(`/deny?${new URLSearchParams(params)}`, { method: "POST", headers })
}

describe("routes/oauth", () => {
  describe("POST /register", () => {
    it("registers a client with valid metadata", async () => {
      const res = await register({ redirect_uris: ["http://localhost:1234/callback"], client_name: "Claude Code" })
      expect(res.status).toBe(201)
      const json = (await res.json()) as { client_id: string; client_name: string }
      expect(json.client_id).toBeString()
      expect(json.client_name).toBe("Claude Code")
    })

    it("rejects invalid metadata with invalid_client_metadata", async () => {
      for (const body of [
        {},
        { redirect_uris: [] },
        { redirect_uris: [42] },
        { redirect_uris: ["javascript:alert(1)"] },
        { redirect_uris: ["http://localhost/cb"], client_name: 1 },
      ]) {
        const res = await register(body)
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata")
      }
    })
  })

  describe("POST /deny", () => {
    it("redirects to a registered redirect_uri with access_denied and the state", async () => {
      const res = await register({ redirect_uris: ["http://localhost:1234/callback"] })
      const { client_id } = (await res.json()) as { client_id: string }

      const denied = await deny({ client_id, redirect_uri: "http://localhost:1234/callback", state: "xyz" })
      expect(denied.status).toBe(302)
      const location = new URL(denied.headers.get("location")!)
      expect(location.origin + location.pathname).toBe("http://localhost:1234/callback")
      expect(location.searchParams.get("error")).toBe("access_denied")
      expect(location.searchParams.get("state")).toBe("xyz")
    })

    it("refuses a redirect_uri the client did not register", async () => {
      const res = await register({ redirect_uris: ["http://localhost:1234/callback"] })
      const { client_id } = (await res.json()) as { client_id: string }

      const denied = await deny({ client_id, redirect_uri: "https://evil.example/login" })
      expect(denied.status).toBe(400)
      expect(denied.headers.get("location")).toBeNull()
    })

    it("refuses non-http(s) and missing redirect_uris", async () => {
      expect((await deny({ redirect_uri: "javascript:alert(1)" })).status).toBe(400)
      expect((await deny({})).status).toBe(400)
    })

    it("refuses cross-origin browser requests", async () => {
      const res = await deny({ redirect_uri: "http://localhost:1234/callback" }, { "sec-fetch-site": "cross-site" })
      expect(res.status).toBe(403)
    })
  })
})
