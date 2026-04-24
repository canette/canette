import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import { requireAdmin } from "../middleware/require-admin"
import type { AppEnv } from "../types"
import { ServiceError } from "../services/errors"
import {
  listTeams,
  getTeam,
  getTeamMembers,
  createTeam,
  renameTeam,
  deleteTeam,
  addMember,
  removeMember,
  findUserByEmail,
} from "../services/teams"
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

// Create a team (admin only)
// POST /api/v1/teams
teamsRouter.post("/", requireAdmin, async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ name: string }>()
  try {
    const team = await createTeam(db, session.user.id, session.user.role, body)
    return c.json(team, 201)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Rename a team (admin only)
// PATCH /api/v1/teams/:id
teamsRouter.patch("/:id", requireAdmin, async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ name: string }>()
  try {
    const team = await renameTeam(db, c.req.param("id"), body.name, session.user.id, session.user.role)
    return c.json(team)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Delete a team (admin only)
// DELETE /api/v1/teams/:id
teamsRouter.delete("/:id", requireAdmin, async (c) => {
  const session = c.get("session")
  try {
    await deleteTeam(db, c.req.param("id"), session.user.id, session.user.role)
    return c.body(null, 204)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Add a member to a team (admin only)
// POST /api/v1/teams/:id/members
teamsRouter.post("/:id/members", requireAdmin, async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ userId?: string; email?: string }>()
  try {
    let targetUserId = body.userId
    if (!targetUserId && body.email) {
      const found = await findUserByEmail(db, body.email)
      if (!found) return c.json({ error: "No user found with that email", code: "NOT_FOUND" }, 404)
      targetUserId = found.id
    }
    if (!targetUserId) return c.json({ error: "userId or email is required", code: "VALIDATION_ERROR" }, 400)
    await addMember(db, c.req.param("id"), targetUserId, session.user.id, session.user.role)
    return c.body(null, 204)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Remove a member from a team (admin only)
// DELETE /api/v1/teams/:id/members/:userId
teamsRouter.delete("/:id/members/:userId", requireAdmin, async (c) => {
  const session = c.get("session")
  try {
    await removeMember(db, c.req.param("id"), c.req.param("userId"), session.user.id, session.user.role)
    return c.body(null, 204)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
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
