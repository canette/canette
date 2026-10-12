import { createMiddleware } from "hono/factory"
import { jwtVerify } from "jose"
import { db } from "../db/db"
import { jwtSecret } from "../services/oauth"

export type McpEnv = {
  Variables: {
    mcpUserId: string
  }
}

// isSessionActive checks that the web session a token was issued from still
// exists, hasn't expired and belongs to a user who isn't banned. Signing out,
// a ban, deleting the user and ending an impersonation all remove the session
// row, so the token stops working at that moment instead of at its own expiry.
async function isSessionActive(userId: string, sessionId: string): Promise<boolean> {
  const row = await db
    .selectFrom("session as s")
    .innerJoin("user as u", "u.id", "s.userId")
    .select(["s.expiresAt", "u.banned"])
    .where("s.id", "=", sessionId)
    .where("s.userId", "=", userId)
    .executeTakeFirst()
  if (!row || row.banned) return false
  // NaN (an unreadable timestamp) compares false, so it fails closed.
  return new Date(row.expiresAt).getTime() > Date.now()
}

export const requireBearer = createMiddleware<McpEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    c.header("WWW-Authenticate", 'Bearer realm="canette"')
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401)
  }
  let userId: string
  try {
    const token = authHeader.slice(7)
    const { payload } = await jwtVerify(token, jwtSecret())
    if (!payload.sub || typeof payload.sid !== "string") throw new Error("missing sub or sid")
    if (!(await isSessionActive(payload.sub, payload.sid))) throw new Error("session ended")
    userId = payload.sub
  } catch {
    c.header("WWW-Authenticate", 'Bearer realm="canette", error="invalid_token"')
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401)
  }
  c.set("mcpUserId", userId)
  await next()
})
