import { describe, it, expect, beforeAll } from "vitest"
import { createStateToken, verifyStateToken } from "../../src/utils/github-app-state"

beforeAll(() => {
  // The state token utility reads ENCRYPTION_KEY at call time (not module load),
  // so we can set it here before any test runs.
  process.env.ENCRYPTION_KEY = "a".repeat(64)
})

describe("utils/github-app-state", () => {
  it("round-trips a valid token", () => {
    const token = createStateToken("team-1", "user-1")
    const claims = verifyStateToken(token)
    expect(claims).toEqual({ teamId: "team-1", userId: "user-1" })
  })

  it("rejects a tampered payload", () => {
    const token = createStateToken("team-1", "user-1")
    const [, sig] = token.split(".")
    const tampered = Buffer.from(
      JSON.stringify({ teamId: "team-2", userId: "user-1", exp: Date.now() + 60000 })
    ).toString("base64url")
    expect(verifyStateToken(`${tampered}.${sig}`)).toBeNull()
  })

  it("rejects a tampered signature", () => {
    const token = createStateToken("team-1", "user-1")
    const dot = token.lastIndexOf(".")
    const payload = token.slice(0, dot)
    expect(verifyStateToken(`${payload}.invalidsig`)).toBeNull()
  })

  it("rejects a token signed with a different key", () => {
    const token = createStateToken("team-1", "user-1")
    process.env.ENCRYPTION_KEY = "b".repeat(64)
    expect(verifyStateToken(token)).toBeNull()
    process.env.ENCRYPTION_KEY = "a".repeat(64)
  })

  it("rejects an expired token", async () => {
    // Build a token with exp in the past by constructing the payload manually
    const { createHmac } = await import("node:crypto")
    const key = Buffer.from("a".repeat(64), "hex")
    const exp = Date.now() - 1000
    const payload = Buffer.from(JSON.stringify({ teamId: "t", userId: "u", exp })).toString("base64url")
    const sig = createHmac("sha256", key).update(payload).digest("base64url")
    expect(verifyStateToken(`${payload}.${sig}`)).toBeNull()
  })

  it("rejects a token with no dot separator", () => {
    expect(verifyStateToken("nodot")).toBeNull()
  })

  it("rejects a token with malformed payload", async () => {
    const { createHmac } = await import("node:crypto")
    const key = Buffer.from("a".repeat(64), "hex")
    const payload = Buffer.from("not-valid-json").toString("base64url")
    const sig = createHmac("sha256", key).update(payload).digest("base64url")
    expect(verifyStateToken(`${payload}.${sig}`)).toBeNull()
  })
})
