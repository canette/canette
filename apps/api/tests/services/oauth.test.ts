import { createHash } from "crypto"
import { describe, expect, it } from "bun:test"
import {
  MAX_CLIENT_NAME_LENGTH,
  MAX_CLIENTS,
  MAX_REDIRECT_URI_LENGTH,
  MAX_REDIRECT_URIS,
  checkRedirectUri,
  exchangeAuthCode,
  getClient,
  isCrossOriginBrowserRequest,
  issueAuthCode,
  parseClientMetadata,
  registerClient,
} from "../../src/services/oauth"

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

  describe("parseClientMetadata", () => {
    const cb = "http://localhost:1234/callback"

    it("accepts valid metadata", () => {
      expect(parseClientMetadata({ redirect_uris: [cb], client_name: "Cursor" })).toEqual({
        redirectUris: [cb],
        clientName: "Cursor",
      })
      expect(parseClientMetadata({ redirect_uris: [cb] })).toEqual({ redirectUris: [cb], clientName: undefined })
    })

    it("bounds the number and length of redirect_uris", () => {
      expect(parseClientMetadata({ redirect_uris: Array(MAX_REDIRECT_URIS).fill(cb) })).not.toHaveProperty("error")
      expect(parseClientMetadata({ redirect_uris: Array(MAX_REDIRECT_URIS + 1).fill(cb) })).toHaveProperty("error")
      const long = `https://example.com/${"a".repeat(MAX_REDIRECT_URI_LENGTH)}`
      expect(parseClientMetadata({ redirect_uris: [long] })).toHaveProperty("error")
    })

    it("rejects redirect_uris that are not http(s) URL strings", () => {
      for (const uri of [42, null, { href: cb }, "not a url", "javascript:alert(1)", "data:text/html,x"]) {
        expect(parseClientMetadata({ redirect_uris: [uri] })).toHaveProperty("error")
      }
      expect(parseClientMetadata({ redirect_uris: "http://localhost/cb" })).toHaveProperty("error")
    })

    it("bounds client_name", () => {
      expect(parseClientMetadata({ redirect_uris: [cb], client_name: "a".repeat(MAX_CLIENT_NAME_LENGTH) })).not.toHaveProperty("error")
      expect(parseClientMetadata({ redirect_uris: [cb], client_name: "a".repeat(MAX_CLIENT_NAME_LENGTH + 1) })).toHaveProperty("error")
      expect(parseClientMetadata({ redirect_uris: [cb], client_name: 42 })).toHaveProperty("error")
    })
  })

  it("evicts the least recently used client once the store is full", () => {
    const first = registerClient(["http://localhost/first"])
    const second = registerClient(["http://localhost/second"])
    // Using first moves it to the back, so second is now the oldest.
    expect(getClient(first.clientId)).toEqual(first)
    for (let i = 0; i < MAX_CLIENTS - 1; i++) registerClient(["http://localhost/filler"])

    expect(getClient(second.clientId)).toBeUndefined()
    expect(getClient(first.clientId)).toEqual(first)
  })

  describe("checkRedirectUri", () => {
    it("accepts a registered URI, and any http(s) URI for an unknown client", () => {
      const client = registerClient(["http://localhost:1/cb"])
      expect(checkRedirectUri("http://localhost:1/cb", client.clientId)).toBeNull()
      expect(checkRedirectUri("https://example.com/cb", "unknown-client")).toBeNull()
      expect(checkRedirectUri("https://example.com/cb", undefined)).toBeNull()
    })

    it("rejects unregistered, non-http(s) and missing URIs", () => {
      const client = registerClient(["http://localhost:1/cb"])
      expect(checkRedirectUri("https://evil.example/login", client.clientId)).not.toBeNull()
      expect(checkRedirectUri("javascript:alert(1)", undefined)).not.toBeNull()
      expect(checkRedirectUri(undefined, undefined)).not.toBeNull()
    })
  })
})
