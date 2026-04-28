// HMAC-signed state tokens for the GitHub App installation callback.
// Binds a (teamId, userId) pair to the callback with a 10-minute expiry.
// Uses BETTER_AUTH_SECRET as the signing key via HS256.

import { SignJWT, jwtVerify } from "jose"

const STATE_TTL_SECONDS = 10 * 60

function signingKey(): Uint8Array {
  return new TextEncoder().encode(process.env.BETTER_AUTH_SECRET ?? "")
}

export async function createStateToken(teamId: string, userId: string): Promise<string> {
  return new SignJWT({ teamId, userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(signingKey())
}

export async function verifyStateToken(state: string): Promise<{ teamId: string; userId: string } | null> {
  try {
    const { payload } = await jwtVerify(state, signingKey())
    if (typeof payload.teamId !== "string" || typeof payload.userId !== "string") return null
    return { teamId: payload.teamId, userId: payload.userId }
  } catch {
    return null
  }
}
