import { createHash } from "crypto"
import { describe, expect, it } from "bun:test"
import { exchangeAuthCode, isCrossOriginBrowserRequest, issueAuthCode } from "../../src/services/oauth"

const UI = "https://canette.example.com"

describe("services/oauth", () => {
  describe("isCrossOriginBrowserRequest", () => {
    const check = (headers: Record<string, string>) => isCrossOriginBrowserRequest(new Headers(headers), UI)

    it("allows the UI's server-to-server call, which carries neither header", () => {
      expect(check({})).toBe(false)
    })

    it("allows a request from the UI's own origin", () => {
      expect(check({ origin: UI, "sec-fetch-site": "same-origin" })).toBe(false)
    })

    it("blocks a form post from an app on a sibling subdomain", () => {
      expect(check({ origin: "https://evil.apps.example.com", "sec-fetch-site": "same-site" })).toBe(true)
      expect(check({ origin: "https://evil.apps.example.com" })).toBe(true)
      expect(check({ "sec-fetch-site": "same-site" })).toBe(true)
    })

    it("blocks other sites and unreadable origins", () => {
      expect(check({ "sec-fetch-site": "cross-site" })).toBe(true)
      expect(check({ origin: "null" })).toBe(true)
      expect(check({ origin: "http://canette.example.com" })).toBe(true)
    })
  })

  it("carries the authorizing session through the code exchange, once", () => {
    const verifier = "verifier"
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const code = issueAuthCode("userId", "sessionId", challenge, "http://localhost:1/cb")

    expect(exchangeAuthCode(code, "wrong", "http://localhost:1/cb")).toBeNull()
    expect(exchangeAuthCode(code, verifier, "http://localhost:1/cb")).toEqual({ userId: "userId", sessionId: "sessionId" })
    expect(exchangeAuthCode(code, verifier, "http://localhost:1/cb")).toBeNull()
  })
})
