import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { getAppPodTarget } from "../services/app-logs"
import { fetchFromLogstreamer } from "../services/logstreamer"
import type { AppMetricsTimeseries, AppMetricsUsage } from "@canette/types"

export const appMetricsRouter = new Hono<AppEnv>()

appMetricsRouter.use("*", requireAuth)

// GET /api/v1/apps/:id/metrics/usage
// Proxies current pod health + CPU/memory usage from logstreamer.
appMetricsRouter.get("/apps/:id/metrics/usage", async (c) => {
  const session = c.get("session")

  const podTarget = await getAppPodTarget(db, c.req.param("id"), session.user.id)
  if (!podTarget) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)

  const body = await fetchFromLogstreamer<AppMetricsUsage>("/metrics/usage", podTarget)
  if (!body) return c.json({ error: "Failed to fetch metrics", code: "UPSTREAM_ERROR" }, 502)
  return c.json(body)
})

// GET /api/v1/apps/:id/metrics/timeseries
// Proxies CPU/memory history from logstreamer's optional Prometheus backend.
// Unlike /metrics/usage, this can legitimately be unavailable (no Prometheus
// configured on the cluster) — logstreamer reports that as a 200 with
// available:false, never as an HTTP error, so this route stays a dumb proxy.
appMetricsRouter.get("/apps/:id/metrics/timeseries", async (c) => {
  const session = c.get("session")

  const podTarget = await getAppPodTarget(db, c.req.param("id"), session.user.id)
  if (!podTarget) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)

  const body = await fetchFromLogstreamer<AppMetricsTimeseries>("/metrics/timeseries", podTarget)
  if (!body) return c.json({ error: "Failed to fetch metrics", code: "UPSTREAM_ERROR" }, 502)
  return c.json(body)
})
