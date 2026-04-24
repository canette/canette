import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { ServiceError } from "../services/errors"
import { getAppById } from "../services/apps"
import { listEnvVars, upsertEnvVar, deleteEnvVar } from "../services/env-vars"
import { listSecrets, upsertSecret, deleteSecret } from "../services/secrets"

export const envRouter = new Hono<AppEnv>()

envRouter.use("*", requireAuth)

// Combined list: env vars + secrets (keys only) for an app
// GET /api/v1/apps/:id/env
envRouter.get("/apps/:id/env", async (c) => {
  const session = c.get("session")
  const app = await getAppById(db, c.req.param("id"), session.user.id)
  if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const [envVars, secrets] = await Promise.all([
    listEnvVars(db, app.id),
    listSecrets(db, app.id),
  ])
  return c.json({ envVars, secrets })
})

const MAX_VALUE_BYTES = 10 * 1024 // 10 KB

// Upsert an env var
// PUT /api/v1/apps/:id/env/:key
envRouter.put("/apps/:id/env/:key", async (c) => {
  const session = c.get("session")
  const app = await getAppById(db, c.req.param("id"), session.user.id)
  if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const body = await c.req.json<{ value: string }>()
  const value = body.value ?? ""
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    return c.json({ error: "Value exceeds 10 KB limit", code: "VALUE_TOO_LARGE" }, 400)
  }
  try {
    const envVar = await upsertEnvVar(db, app.id, c.req.param("key"), value)
    return c.json(envVar)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Delete an env var
// DELETE /api/v1/apps/:id/env/:key
envRouter.delete("/apps/:id/env/:key", async (c) => {
  const session = c.get("session")
  const app = await getAppById(db, c.req.param("id"), session.user.id)
  if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const deleted = await deleteEnvVar(db, app.id, c.req.param("key"))
  if (!deleted) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.body(null, 204)
})

// Upsert a secret (value is encrypted, never returned)
// PUT /api/v1/apps/:id/secrets/:key
envRouter.put("/apps/:id/secrets/:key", async (c) => {
  const session = c.get("session")
  const app = await getAppById(db, c.req.param("id"), session.user.id)
  if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const body = await c.req.json<{ value: string }>()
  const value = body.value ?? ""
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    return c.json({ error: "Value exceeds 10 KB limit", code: "VALUE_TOO_LARGE" }, 400)
  }
  try {
    const secret = await upsertSecret(db, app.id, c.req.param("key"), value)
    return c.json(secret)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Delete a secret
// DELETE /api/v1/apps/:id/secrets/:key
envRouter.delete("/apps/:id/secrets/:key", async (c) => {
  const session = c.get("session")
  const app = await getAppById(db, c.req.param("id"), session.user.id)
  if (!app) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const deleted = await deleteSecret(db, app.id, c.req.param("key"))
  if (!deleted) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.body(null, 204)
})
