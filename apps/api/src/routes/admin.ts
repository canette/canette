import { randomInt } from "crypto"
import { Hono } from "hono"
import { db } from "../db/db"
import { auth } from "../auth/auth"
import { requireAuth } from "../middleware/require-auth"
import { requireAdmin } from "../middleware/require-admin"
import type { AppEnv } from "../types"
import { ServiceError } from "../services/errors"
import {
  deleteUser,
  forceSyncLiveApps,
  getProjectsOverview,
  getResourceDefaults,
  getScanPolicy,
  getTeamMembersForAdmin,
  getUserDeletionImpact,
  getWebhookSettings,
  listUsers,
  resetStuckBuilds,
  updateScanPolicy,
  updateUserRole,
} from "../services/admin"
import { listTeamsOverview } from "../services/teams"
import type { ScanPolicy, UserRole } from "@canette/types"

function generatePassword(): string {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  const lower = "abcdefghijklmnopqrstuvwxyz"
  const digits = "0123456789"
  const all = upper + lower + digits
  const chars = [
    upper[randomInt(upper.length)],
    lower[randomInt(lower.length)],
    digits[randomInt(digits.length)],
    ...Array.from({ length: 13 }, () => all[randomInt(all.length)]),
  ]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join("")
}

export const adminRouter = new Hono<AppEnv>()

// Both middlewares are required — requireAuth first to attach the session,
// then requireAdmin to verify the user is a global admin.
adminRouter.use("*", requireAuth)
adminRouter.use("*", requireAdmin)

// List all users
// GET /api/v1/admin/users
adminRouter.get("/users", async (c) => {
  const users = await listUsers(db)
  return c.json(users)
})

// Update a user's role
// PATCH /api/v1/admin/users/:id
adminRouter.patch("/users/:id", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ role: UserRole }>()
  try {
    const user = await updateUserRole(db, c.req.param("id"), body.role, session.user.id)
    return c.json(user)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Reset a user's password — generates a new random password, returns it once
// POST /api/v1/admin/users/:id/reset-password
adminRouter.post("/users/:id/reset-password", async (c) => {
  const newPassword = generatePassword()
  try {
    await auth.api.setUserPassword({
      body: { userId: c.req.param("id"), newPassword },
      headers: c.req.raw.headers,
    })
    return c.json({ password: newPassword })
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Get deletion impact summary for a user (projects, apps, in-flight builds)
// GET /api/v1/admin/users/:id/deletion-impact
adminRouter.get("/users/:id/deletion-impact", async (c) => {
  try {
    const impact = await getUserDeletionImpact(db, c.req.param("id"))
    return c.json(impact)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Delete a user
// DELETE /api/v1/admin/users/:id
// Body: { force?: boolean } — required when user has projects; stops live apps and cascades
adminRouter.delete("/users/:id", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }))
  try {
    const deleted = await deleteUser(db, c.req.param("id"), session.user.id, { force: body.force })
    if (!deleted) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
    return c.body(null, 204)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// All projects with their apps and latest deployment status
// GET /api/v1/admin/overview
adminRouter.get("/overview", async (c) => {
  const overview = await getProjectsOverview(db)
  return c.json(overview)
})

// All teams with member and project counts
// GET /api/v1/admin/teams
adminRouter.get("/teams", async (c) => {
  const teams = await listTeamsOverview(db)
  return c.json(teams)
})

// Get members of any team (admin, no membership required)
// GET /api/v1/admin/teams/:id/members
adminRouter.get("/teams/:id/members", async (c) => {
  const members = await getTeamMembersForAdmin(db, c.req.param("id"))
  if (!members) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json(members)
})

// Force-sync: re-queue all live apps for reconciliation
// POST /api/v1/admin/sync
adminRouter.post("/sync", async (c) => {
  const result = await forceSyncLiveApps(db)
  return c.json(result)
})

// Reset stuck builds: mark building/scanning deployments as failed
// POST /api/v1/admin/reset-stuck
adminRouter.post("/reset-stuck", async (c) => {
  const result = await resetStuckBuilds(db)
  return c.json(result)
})

// Get security / scan policy
// GET /api/v1/admin/settings/security
adminRouter.get("/settings/security", async (c) => {
  const policy = await getScanPolicy(db)
  return c.json(policy)
})

// Update security / scan policy
// PATCH /api/v1/admin/settings/security
adminRouter.patch("/settings/security", async (c) => {
  const body = await c.req.json<Partial<ScanPolicy>>()
  try {
    const policy = await updateScanPolicy(db, body)
    return c.json(policy)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Get resource defaults (read-only — configured via Helm values)
// GET /api/v1/admin/settings/resources
adminRouter.get("/settings/resources", (c) => {
  return c.json(getResourceDefaults())
})

// Get webhook settings (read-only — configured via Helm values)
// GET /api/v1/admin/settings/webhooks
adminRouter.get("/settings/webhooks", (c) => {
  return c.json(getWebhookSettings())
})
