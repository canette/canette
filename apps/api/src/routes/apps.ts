import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { ServiceError } from "../services/errors"
import {
  createApp,
  deleteApp,
  getAppById,
  getAppByRef,
  isAppSlugAvailable,
  listApps,
  updateApp,
} from "../services/apps"
import {
  createDeployment,
  getDeploymentLogs,
  listDeployments,
  redeployDeployment,
  stopApp,
} from "../services/deployments"

export const appsRouter = new Hono<AppEnv>()

appsRouter.use("*", requireAuth)

// Slug availability check within a project
// GET /api/v1/projects/:projectId/apps/slug-available?slug=my-app
appsRouter.get("/projects/:projectId/apps/slug-available", async (c) => {
  const slug = c.req.query("slug") ?? ""
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || slug.endsWith("-")) {
    return c.json({ available: false, error: "Invalid slug format" })
  }
  const available = await isAppSlugAvailable(db, c.req.param("projectId"), slug)
  return c.json({ available })
})

// List apps for a project
// GET /api/v1/projects/:projectId/apps
appsRouter.get("/projects/:projectId/apps", async (c) => {
  const session = c.get("session")
  const result = await listApps(db, c.req.param("projectId"), session.user.id)
  if (!result) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json(result)
})

// Create an app
// POST /api/v1/projects/:projectId/apps
appsRouter.post("/projects/:projectId/apps", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{
    name: string
    slug: string
    sourceType?: "git" | "image"
    gitUrl?: string
    gitBranch?: string
    gitCredentialId?: string
    appPath?: string
    imageUrl?: string
    imageTag?: string
    port?: number
    canetteConfig?: string
  }>()
  try {
    const app = await createApp(db, c.req.param("projectId"), session.user.id, body)
    return c.json(app, 201)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Get app by project ref + app ref (UUID or slug for both)
// GET /api/v1/projects/:projectRef/apps/:appRef
appsRouter.get("/projects/:projectRef/apps/:appRef", async (c) => {
  const session = c.get("session")
  const app = await getAppByRef(
    db,
    c.req.param("projectRef"),
    c.req.param("appRef"),
    session.user.id
  )
  if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json(app)
})

// Get a single app by id
// GET /api/v1/apps/:id
appsRouter.get("/apps/:id", async (c) => {
  const session = c.get("session")
  const app = await getAppById(db, c.req.param("id"), session.user.id)
  if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json(app)
})

// Update an app
// PATCH /api/v1/apps/:id
appsRouter.patch("/apps/:id", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{
    name?: string
    sourceType?: "git" | "image"
    gitUrl?: string
    gitBranch?: string
    appPath?: string
    imageUrl?: string
    imageTag?: string
    port?: number
    gitCredentialId?: string | null
    canetteConfig?: string | null
  }>()
  try {
    const app = await updateApp(db, c.req.param("id"), session.user.id, body)
    if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
    return c.json(app)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Delete an app
// DELETE /api/v1/apps/:id
appsRouter.delete("/apps/:id", async (c) => {
  const session = c.get("session")
  const deleted = await deleteApp(db, c.req.param("id"), session.user.id)
  if (!deleted) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.body(null, 204)
})

// Stop an app — marks all non-failed deployments as failed
// POST /api/v1/apps/:id/stop
appsRouter.post("/apps/:id/stop", async (c) => {
  const session = c.get("session")
  const ok = await stopApp(db, c.req.param("id"), session.user.id)
  if (!ok) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json({ ok: true })
})

// List deployments for an app
// GET /api/v1/apps/:id/deployments
appsRouter.get("/apps/:id/deployments", async (c) => {
  const session = c.get("session")
  const app = await getAppById(db, c.req.param("id"), session.user.id)
  if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const result = await listDeployments(db, app.id)
  return c.json(result)
})

// Trigger a manual deployment — commit info is read from the app record.
// POST /api/v1/apps/:id/deployments
appsRouter.post("/apps/:id/deployments", async (c) => {
  const session = c.get("session")
  try {
    const deployment = await createDeployment(db, c.req.param("id"), session.user.id)
    return c.json(deployment, 201)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Redeploy an existing built deployment without rebuilding the image
// POST /api/v1/deployments/:id/redeploy
appsRouter.post("/deployments/:id/redeploy", async (c) => {
  const session = c.get("session")
  try {
    const deployment = await redeployDeployment(db, c.req.param("id"), session.user.id)
    if (!deployment) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
    return c.json(deployment)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Get build logs for a deployment
// GET /api/v1/deployments/:deploymentId/logs
appsRouter.get("/deployments/:deploymentId/logs", async (c) => {
  const session = c.get("session")
  const logs = await getDeploymentLogs(db, c.req.param("deploymentId"), session.user.id)
  if (!logs) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json({ items: logs })
})
