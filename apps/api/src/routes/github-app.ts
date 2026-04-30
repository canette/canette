import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { upsertGithubAppInstallation, listLinkableInstallations, linkInstallationToTeam } from "../services/git-credentials"
import { isTeamMember } from "../services/membership"
import { ServiceError } from "../services/errors"
import { getInstallationDetails } from "../services/github-app-token"
import { createStateToken, verifyStateToken } from "../utils/github-app-state"

export const githubAppRouter = new Hono<AppEnv>()

// ── Routes ────────────────────────────────────────────────────────────────────

// normalizePublicLink accepts either a full URL or a bare slug and always returns
// a full https://github.com/apps/{slug} URL.
function normalizePublicLink(value: string): string {
  if (value.startsWith("https://")) return value.replace(/\/$/, "")
  return `https://github.com/apps/${value.replace(/^\//, "")}`
}

// GET /api/v1/github-app/install-url?teamId=:teamId
// Returns the GitHub App installation URL for the current team.
// Only available when GITHUB_APP_PUBLIC_LINK and GITHUB_APP_ID are configured.
githubAppRouter.get("/install-url", requireAuth, async (c) => {
  const publicLink = process.env.GITHUB_APP_PUBLIC_LINK
  if (!publicLink || !process.env.GITHUB_APP_ID) {
    return c.json({ available: false })
  }

  const teamId = c.req.query("teamId")
  if (!teamId) {
    return c.json({ error: "teamId is required", code: "VALIDATION_ERROR" }, 400)
  }

  const session = c.get("session")
  const member = await isTeamMember(db, teamId, session.user.id)
  if (!member) {
    return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  }

  const state = await createStateToken(teamId, session.user.id)
  const url = `${normalizePublicLink(publicLink)}/installations/new?state=${state}`
  return c.json({ available: true, url })
})

// GET /api/v1/github-app/callback?installation_id=:id&setup_action=:action&state=:token
// GitHub redirects the user here after installation. No auth cookie required
// since the browser is being redirected from GitHub. The signed state token
// carries the identity and team context.
githubAppRouter.get("/callback", async (c) => {
  const uiBase = process.env.UI_URL ?? "http://localhost:3000"
  const installationId = c.req.query("installation_id")
  const setupAction = c.req.query("setup_action") ?? "install"
  const state = c.req.query("state")

  if (!state) {
    return c.redirect(`${uiBase}/dashboard?error=github-app-missing-state`)
  }

  const claims = await verifyStateToken(state)
  if (!claims) {
    return c.redirect(`${uiBase}/dashboard?error=github-app-invalid-state`)
  }
  const { teamId } = claims

  if (setupAction === "request") {
    // The user requested access that hasn't been approved yet.
    return c.redirect(`${uiBase}/dashboard/teams/${teamId}?tab=credentials&github_app=pending`)
  }

  if (!installationId) {
    return c.redirect(`${uiBase}/dashboard/teams/${teamId}?tab=credentials&error=github-app-no-installation`)
  }

  try {
    const details = await getInstallationDetails(installationId)
    const accountLogin = details?.account?.login ?? installationId

    await upsertGithubAppInstallation(db, teamId, installationId, accountLogin, claims.userId)
  } catch (err) {
    console.error("GitHub App callback error", err)
    return c.redirect(`${uiBase}/dashboard/teams/${teamId}?tab=credentials&error=github-app-callback-failed`)
  }

  return c.redirect(`${uiBase}/dashboard/teams/${teamId}?tab=credentials&github_app=installed`)
})

// GET /api/v1/github-app/linkable?teamId=:teamId
// Returns GitHub App installations the current user personally connected on other teams,
// excluding any already linked to teamId.
githubAppRouter.get("/linkable", requireAuth, async (c) => {
  const teamId = c.req.query("teamId")
  if (!teamId) {
    return c.json({ error: "teamId is required", code: "VALIDATION_ERROR" }, 400)
  }
  const session = c.get("session")
  const installations = await listLinkableInstallations(db, teamId, session.user.id)
  return c.json({ installations })
})

// POST /api/v1/github-app/link
// Links an installation the caller personally connected to an additional team they belong to.
githubAppRouter.post("/link", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { teamId, installationId } = body as { teamId?: string; installationId?: string }
  if (!teamId || !installationId) {
    return c.json({ error: "teamId and installationId are required", code: "VALIDATION_ERROR" }, 400)
  }
  const session = c.get("session")
  try {
    const cred = await linkInstallationToTeam(db, teamId, session.user.id, installationId)
    return c.json(cred, 201)
  } catch (err) {
    if (err instanceof ServiceError) return c.json({ error: err.message, code: err.code }, err.status as 400 | 403 | 404 | 409 | 422)
    throw err
  }
})
