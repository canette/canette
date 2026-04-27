// HMAC-signed state tokens for the GitHub App installation callback.
// Binds a (teamId, userId) pair to the callback with a 10-minute expiry.
// Uses ENCRYPTION_KEY as the signing key (already required at startup).

import { createHmac, timingSafeEqual } from "node:crypto"

const STATE_TTL_MS = 10 * 60 * 1000

function signingKey(): Buffer {
  return Buffer.from(process.env.ENCRYPTION_KEY ?? "", "hex")
}

export function createStateToken(teamId: string, userId: string): string {
  const exp = Date.now() + STATE_TTL_MS
  const payload = Buffer.from(JSON.stringify({ teamId, userId, exp })).toString("base64url")
  const sig = createHmac("sha256", signingKey()).update(payload).digest("base64url")
  return `${payload}.${sig}`
}

export function verifyStateToken(state: string): { teamId: string; userId: string } | null {
  const dot = state.lastIndexOf(".")
  if (dot === -1) return null
  const payload = state.slice(0, dot)
  const sig = state.slice(dot + 1)
  const expectedSig = createHmac("sha256", signingKey()).update(payload).digest("base64url")
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof parsed.teamId !== "string" || typeof parsed.userId !== "string" || typeof parsed.exp !== "number") return null
    if (Date.now() > parsed.exp) return null
    return { teamId: parsed.teamId, userId: parsed.userId }
  } catch {
    return null
  }
}
