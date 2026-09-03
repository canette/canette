import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { getAppNamespace } from "../services/app-logs"
import type { AppMetricsTimeseries, AppMetricsUsage } from "@canette/types"

export const appMetricsRouter = new Hono<AppEnv>()

appMetricsRouter.use("*", requireAuth)

// GET /api/v1/apps/:id/metrics/usage
// Proxies current pod health + CPU/memory usage from logstreamer.
appMetricsRouter.get("/apps/:id/metrics/usage", async (c) => {
  const session = c.get("session")

  const appNs = await getAppNamespace(db, c.req.param("id"), session.user.id)
  if (!appNs) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)

  const base = process.env.LOGSTREAMER_URL ?? "http://localhost:8080"
  let url = `${base}/metrics/usage?project_id=${encodeURIComponent(appNs.projectId)}&project_slug=${encodeURIComponent(appNs.projectSlug)}&app=${encodeURIComponent(appNs.appSlug)}`
  // Scopes the pod list to the app's current deployment so a leftover pod
  // from a previous, still-terminating deployment isn't shown as if it
  // belonged to the current one.
  if (appNs.liveDeploymentId) {
    url += `&deployment_id=${encodeURIComponent(appNs.liveDeploymentId)}`
  }

  const secret = process.env.LOGSTREAMER_SECRET ?? ""
  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
  })
  if (!upstream.ok) {
    return c.json({ error: "Failed to fetch metrics", code: "UPSTREAM_ERROR" }, 502)
  }

  const body = (await upstream.json()) as AppMetricsUsage
  return c.json(body)
})

// GET /api/v1/apps/:id/metrics/timeseries
// Proxies CPU/memory history from logstreamer's optional Prometheus backend.
// Unlike /metrics/usage, this can legitimately be unavailable (no Prometheus
// configured on the cluster) — logstreamer reports that as a 200 with
// available:false, never as an HTTP error, so this route stays a dumb proxy.
appMetricsRouter.get("/apps/:id/metrics/timeseries", async (c) => {
  const session = c.get("session")

  const appNs = await getAppNamespace(db, c.req.param("id"), session.user.id)
  if (!appNs) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)

  const base = process.env.LOGSTREAMER_URL ?? "http://localhost:8080"
  let url = `${base}/metrics/timeseries?project_id=${encodeURIComponent(appNs.projectId)}&project_slug=${encodeURIComponent(appNs.projectSlug)}&app=${encodeURIComponent(appNs.appSlug)}`
  if (appNs.liveDeploymentId) {
    url += `&deployment_id=${encodeURIComponent(appNs.liveDeploymentId)}`
  }

  const secret = process.env.LOGSTREAMER_SECRET ?? ""
  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
  })
  if (!upstream.ok) {
    return c.json({ error: "Failed to fetch metrics", code: "UPSTREAM_ERROR" }, 502)
  }

  const body = (await upstream.json()) as AppMetricsTimeseries
  return c.json(body)
})
