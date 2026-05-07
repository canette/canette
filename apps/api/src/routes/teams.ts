import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { ServiceError } from "../services/errors"
import { listTeams, getTeam, getTeamMembers } from "../services/teams"
import {
  listTeamCredentials,
  createCredential,
  updateCredential,
  deleteCredential,
} from "../services/git-credentials"
import type { GitProvider, GitCredentialType } from "@canette/types"

export const teamsRouter = new Hono<AppEnv>()

teamsRouter.use("*", requireAuth)

// List teams the current user belongs to
// GET /api/v1/teams
teamsRouter.get("/", async (c) => {
  const session = c.get("session")
  const teams = await listTeams(db, session.user.id)
  return c.json(teams)
})

// Get a team's details + members
// GET /api/v1/teams/:id
teamsRouter.get("/:id", async (c) => {
  const session = c.get("session")
  const teamId = c.req.param("id")
  const [team, members] = await Promise.all([
    getTeam(db, teamId, session.user.id),
    getTeamMembers(db, teamId, session.user.id),
  ])
  if (!team || !members) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json({ ...team, members })
})

// ── Credentials (team-scoped) ─────────────────────────────────────────────────

// List credentials for a team + system credentials
// GET /api/v1/teams/:teamId/credentials
teamsRouter.get("/:teamId/credentials", async (c) => {
  const session = c.get("session")
  const items = await listTeamCredentials(db, c.req.param("teamId"), session.user.id)
  if (!items) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json(items)
})

// Create a credential for a team (any team member)
// POST /api/v1/teams/:teamId/credentials
teamsRouter.post("/:teamId/credentials", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{
    name: string
    provider: GitProvider
    type: GitCredentialType
    value?: string
    sshKnownHosts?: string
  }>()
  try {
    const credential = await createCredential(db, c.req.param("teamId"), session.user.id, body)
    return c.json(credential, 201)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Update a credential's value (any team member)
// PATCH /api/v1/teams/:teamId/credentials/:id
teamsRouter.patch("/:teamId/credentials/:id", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ value: string }>()
  try {
    const credential = await updateCredential(
      db,
      c.req.param("teamId"),
      session.user.id,
      c.req.param("id"),
      body
    )
    if (!credential) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
    return c.json(credential)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Delete a credential (any team member, blocked if app references it)
// DELETE /api/v1/teams/:teamId/credentials/:id
teamsRouter.delete("/:teamId/credentials/:id", async (c) => {
  const session = c.get("session")
  try {
    const deleted = await deleteCredential(
      db,
      c.req.param("teamId"),
      session.user.id,
      c.req.param("id")
    )
    if (!deleted) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
    return c.body(null, 204)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})
