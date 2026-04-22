import { createMiddleware } from "hono/factory"
import { auth } from "../auth"

// Requires the session to belong to a global admin user.
// Must be applied AFTER requireAuth so the session is already on the context.
export const requireAdmin = createMiddleware<{
  Variables: { session: typeof auth.$Infer.Session }
}>(async (c, next) => {
  const session = c.get("session")
  if (!session) {
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401)
  }
  if (session.user?.role !== "admin") {
    return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403)
  }
  await next()
})
