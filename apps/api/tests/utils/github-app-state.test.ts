import { describe, it, expect, beforeAll } from "vitest"
import { SignJWT } from "jose"
import { createStateToken, verifyStateToken } from "../../src/utils/github-app-state"

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret"
})

describe("utils/github-app-state", () => {
  it("round-trips a valid token", async () => {
    const token = await createStateToken("team-1", "user-1")
    const claims = await verifyStateToken(token)
    expect(claims).toEqual({ teamId: "team-1", userId: "user-1" })
  })

  it("rejects a tampered payload", async () => {
    const token = await createStateToken("team-1", "user-1")
    const parts = token.split(".")
    const tampered = Buffer.from(JSON.stringify({ teamId: "team-2", userId: "user-1" })).toString("base64url")
    expect(await verifyStateToken(`${tampered}.${parts[1]}.${parts[2]}`)).toBeNull()
  })

  it("rejects a tampered signature", async () => {
    const token = await createStateToken("team-1", "user-1")
    const parts = token.split(".")
    expect(await verifyStateToken(`${parts[0]}.${parts[1]}.invalidsig`)).toBeNull()
  })

  it("rejects a token signed with a different key", async () => {
    const token = await createStateToken("team-1", "user-1")
    process.env.BETTER_AUTH_SECRET = "other-secret"
    expect(await verifyStateToken(token)).toBeNull()
    process.env.BETTER_AUTH_SECRET = "test-secret"
  })

  it("rejects a token with no dot separators", async () => {
    expect(await verifyStateToken("nodot")).toBeNull()
  })

  it("rejects an expired token", async () => {
    const key = new TextEncoder().encode("test-secret")
    const token = await new SignJWT({ teamId: "team-1", userId: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("-1s")
      .sign(key)
    expect(await verifyStateToken(token)).toBeNull()
  })

  it("rejects a completely invalid string", async () => {
    expect(await verifyStateToken("not.a.jwt")).toBeNull()
  })
})
