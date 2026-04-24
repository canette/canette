import { Hono } from "hono"
import { db } from "../db/db"
import { processWebhookEvent } from "../services/webhooks"

// Public — no auth middleware. Security is handled by HMAC/token validation inside processWebhookEvent.
export const webhookReceiverRouter = new Hono()

// POST /api/v1/webhooks/app/:appId
// Receives push events from GitHub, GitLab, and Gitea.
// Always returns 200 for logical drops (wrong branch, busy app, path filter) to prevent provider retries.
// Returns 401 only on signature/token validation failure.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

webhookReceiverRouter.post("/app/:appId", async (c) => {
  const appId = c.req.param("appId")
  if (!UUID_RE.test(appId)) {
    return c.json({ message: "Not found" }, 404)
  }
  const rawBody = Buffer.from(await c.req.arrayBuffer())

  // Collect all headers as lowercase key → value map for uniform provider handling.
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const { status, message } = await processWebhookEvent(
    db,
    appId,
    rawBody,
    headers
  )

  return c.json({ message }, status as 200 | 400 | 401 | 404)
})
