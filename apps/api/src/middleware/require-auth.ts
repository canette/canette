import { createMiddleware } from "hono/factory"
import { auth } from "../auth/auth"

// Attaches the session to the Hono context. Returns 401 if not authenticated.
export const requireAuth = createMiddleware<{
  Variables: { session: typeof auth.$Infer.Session }
}>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401)
  }
  c.set("session", session)
  await next()
})
