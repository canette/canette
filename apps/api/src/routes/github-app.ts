import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { upsertGithubAppInstallation, isTeamMember } from "../services/git-credentials"
import { getInstallationDetails } from "../services/github-app-token"
import { createStateToken, verifyStateToken } from "../utils/github-app-state"

export const githubAppRouter = new Hono<AppEnv>()

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/v1/github-app/install-url?teamId=:teamId
// Returns the GitHub App installation URL for the current team.
// Only available when GITHUB_APP_SLUG and GITHUB_APP_ID are configured.
githubAppRouter.get("/install-url", requireAuth, async (c) => {
  const slug = process.env.GITHUB_APP_SLUG
  if (!slug || !process.env.GITHUB_APP_ID) {
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

  const state = createStateToken(teamId, session.user.id)
  const url = `https://github.com/apps/${slug}/installations/new?state=${state}`
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

  const claims = verifyStateToken(state)
  if (!claims) {
    return c.redirect(`${uiBase}/dashboard?error=github-app-invalid-state`)
  }
  const { teamId, userId } = claims

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

    await upsertGithubAppInstallation(db, teamId, installationId, accountLogin)
  } catch (err) {
    console.error("GitHub App callback error", err)
    return c.redirect(`${uiBase}/dashboard/teams/${teamId}?tab=credentials&error=github-app-callback-failed`)
  }

  return c.redirect(`${uiBase}/dashboard/teams/${teamId}?tab=credentials&github_app=installed`)
})
