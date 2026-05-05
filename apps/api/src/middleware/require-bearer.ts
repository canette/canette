import { createMiddleware } from "hono/factory"
import { jwtVerify } from "jose"

export type McpEnv = {
  Variables: {
    mcpUserId: string
  }
}

function jwtSecret() {
  const secret = process.env.MCP_JWT_SECRET
  if (!secret) throw new Error("MCP_JWT_SECRET is not set")
  return new TextEncoder().encode(secret)
}

export const requireBearer = createMiddleware<McpEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    c.header("WWW-Authenticate", 'Bearer realm="canette"')
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401)
  }
  try {
    const token = authHeader.slice(7)
    const { payload } = await jwtVerify(token, jwtSecret())
    if (!payload.sub) throw new Error("missing sub")
    c.set("mcpUserId", payload.sub)
    await next()
  } catch {
    c.header("WWW-Authenticate", 'Bearer realm="canette", error="invalid_token"')
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401)
  }
})
