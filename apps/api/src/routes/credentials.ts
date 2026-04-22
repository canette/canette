import { Hono } from "hono"
import { db } from "../db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { ServiceError } from "../services/errors"
import { listCredentials, createCredential, updateCredential, deleteCredential } from "../services/git-credentials"
import type { GitProvider, GitCredentialType } from "@canette/types"

export const credentialsRouter = new Hono<AppEnv>()

credentialsRouter.use("*", requireAuth)

// List all credentials for the current user
// GET /api/v1/credentials
credentialsRouter.get("/credentials", async (c) => {
  const session = c.get("session")
  const items = await listCredentials(db, session.user.id)
  return c.json(items)
})

// Create a credential
// POST /api/v1/credentials
credentialsRouter.post("/credentials", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{
    name: string
    provider: GitProvider
    type: GitCredentialType
    value?: string
    sshKnownHosts?: string
  }>()
  try {
    const credential = await createCredential(db, session.user.id, body)
    return c.json(credential, 201)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Update a credential's value
// PATCH /api/v1/credentials/:id
credentialsRouter.patch("/credentials/:id", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ value: string }>()
  try {
    const credential = await updateCredential(db, session.user.id, c.req.param("id"), body)
    if (!credential) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
    return c.json(credential)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Delete a credential
// DELETE /api/v1/credentials/:id
credentialsRouter.delete("/credentials/:id", async (c) => {
  const session = c.get("session")
  const deleted = await deleteCredential(db, session.user.id, c.req.param("id"))
  if (!deleted) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.body(null, 204)
})
