import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { getDeploymentManifest, getScanSbom } from "../services/app-logs"

export const appLogsRouter = new Hono<AppEnv>()

appLogsRouter.use("*", requireAuth)

// GET /api/v1/deployments/:id/manifest
appLogsRouter.get("/deployments/:id/manifest", async (c) => {
  const session = c.get("session")
  const manifest = await getDeploymentManifest(db, c.req.param("id"), session.user.id)
  if (manifest === null) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json({ manifest })
})

// GET /api/v1/deployments/:id/sbom
appLogsRouter.get("/deployments/:id/sbom", async (c) => {
  const session = c.get("session")
  const sbom = await getScanSbom(db, c.req.param("id"), session.user.id)
  if (sbom === null) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json({ sbom })
})
