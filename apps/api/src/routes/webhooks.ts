import { Hono } from "hono"
import { db } from "../db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { createWebhook, getWebhook, deleteWebhook } from "../services/webhooks"
import { ServiceError } from "../services/errors"

export const webhooksRouter = new Hono<AppEnv>()

webhooksRouter.use("*", requireAuth)

// POST /api/v1/apps/:id/webhook
// Creates (or replaces) the webhook for an app. Returns the plaintext secret once.
webhooksRouter.post("/apps/:id/webhook", async (c) => {
  const session = c.get("session")
  const body = await c.req.json().catch(() => ({})) as { watchPath?: string }
  try {
    const result = await createWebhook(db, c.req.param("id"), session.user.id, {
      watchPath: body.watchPath ?? "",
    })
    return c.json(result, 201)
  } catch (err) {
    if (err instanceof ServiceError) return c.json({ error: err.message, code: err.code }, err.status as 404 | 422)
    throw err
  }
})

// GET /api/v1/apps/:id/webhook
// Returns webhook status (no secret).
webhooksRouter.get("/apps/:id/webhook", async (c) => {
  const session = c.get("session")
  try {
    const config = await getWebhook(db, c.req.param("id"), session.user.id)
    if (!config) return c.json({ error: "No webhook configured", code: "NOT_FOUND" }, 404)
    return c.json(config)
  } catch (err) {
    if (err instanceof ServiceError) return c.json({ error: err.message, code: err.code }, err.status as 404)
    throw err
  }
})

// DELETE /api/v1/apps/:id/webhook
// Removes the webhook and attempts to deregister it from the provider.
webhooksRouter.delete("/apps/:id/webhook", async (c) => {
  const session = c.get("session")
  try {
    const deleted = await deleteWebhook(db, c.req.param("id"), session.user.id)
    if (!deleted) return c.json({ error: "No webhook configured", code: "NOT_FOUND" }, 404)
    return new Response(null, { status: 204 })
  } catch (err) {
    if (err instanceof ServiceError) return c.json({ error: err.message, code: err.code }, err.status as 404)
    throw err
  }
})
