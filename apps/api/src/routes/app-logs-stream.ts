import { Hono } from "hono"
import { stream } from "hono/streaming"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { getAppNamespace } from "../services/app-logs"

export const appLogsStreamRouter = new Hono<AppEnv>()

appLogsStreamRouter.use("*", requireAuth)

// GET /api/v1/apps/:id/logs/stream
// Proxies live pod logs from logstreamer as SSE to the browser.
// Stops when the client disconnects (AbortSignal propagation).
appLogsStreamRouter.get("/apps/:id/logs/stream", async (c) => {
  const session = c.get("session")

  const appNs = await getAppNamespace(db, c.req.param("id"), session.user.id)
  if (!appNs) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)

  const base = process.env.LOGSTREAMER_URL ?? "http://localhost:8080"
  const typeParam = appNs.deploymentType === "cronjob" ? "&type=cronjob" : ""
  const url = `${base}/stream?project_id=${encodeURIComponent(appNs.projectId)}&project_slug=${encodeURIComponent(appNs.projectSlug)}&app=${encodeURIComponent(appNs.appSlug)}${typeParam}`

  const secret = process.env.LOGSTREAMER_SECRET ?? ""
  const upstream = await fetch(url, {
    signal: c.req.raw.signal,
    headers: { Authorization: `Bearer ${secret}` },
  })
  if (!upstream.ok || !upstream.body) {
    const status = upstream.status === 404 ? 404 : 502
    return c.json({ error: "No running pod", code: "NOT_FOUND" }, status)
  }

  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache, no-transform") // prevent gzip - do not remove
  c.header("Content-Encoding", "identity") // prevent gzip - do not remove

  return stream(c, async (stream) => {
    await stream.pipe(upstream.body!)
  })
})
