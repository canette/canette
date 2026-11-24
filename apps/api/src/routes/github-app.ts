import { Hono } from "hono"
import { auth } from "../auth/auth"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { upsertGithubAppInstallation, listLinkableInstallations, linkInstallationToTeam } from "../services/git-credentials"
import { isTeamMember } from "../services/membership"
import { ServiceError } from "../services/errors"
import {
  exchangeUserCode,
  getInstallationDetails,
  githubAppClient,
  userAuthorizeUrl,
  userCanAccessInstallation,
} from "../services/github-app-token"
import { consumeInstallState, createCodeVerifier, createInstallState } from "../services/github-app-state"

export const githubAppRouter = new Hono<AppEnv>()

// ── Routes ────────────────────────────────────────────────────────────────────

// normalizePublicLink accepts either a full URL or a bare slug and always returns
// a full https://github.com/apps/{slug} URL.
function normalizePublicLink(value: string): string {
  if (value.startsWith("https://")) return value.replace(/\/$/, "")
  return `https://github.com/apps/${value.replace(/^\//, "")}`
}

// Both GitHub redirects land on this one path: the Setup URL after
// installation, and the Callback URL after user authorization. The App's
// "Callback URL" must be set to exactly this URL for the OAuth step.
function callbackUrl(): string {
  return `${process.env.UI_URL ?? "http://localhost:3000"}/api/v1/github-app/callback`
}

const INSTALLATION_ID_RE = /^\d{1,20}$/

// GET /api/v1/github-app/install-url?teamId=:teamId
// Returns the GitHub App installation URL for the current team. Only available
// when GITHUB_APP_ID, GITHUB_APP_PUBLIC_LINK and the App's OAuth client
// (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET) are configured: without the
// client, the callback cannot verify that the user owns the installation.
githubAppRouter.get("/install-url", requireAuth, async (c) => {
  const publicLink = process.env.GITHUB_APP_PUBLIC_LINK
  if (!publicLink || !process.env.GITHUB_APP_ID || !githubAppClient()) {
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

  const state = await createInstallState(db, teamId, session.user.id)
  const url = `${normalizePublicLink(publicLink)}/installations/new?state=${state}`
  return c.json({ available: true, url })
})

// GET /api/v1/github-app/callback
// The browser is redirected here from GitHub; the single-use state carries the
// team and user that started the flow, and the browser's own canette session
// must belong to that same user. Without that check, a team member could start
// the flow for someone else's installation and get its owner to open the
// authorize link: GitHub redirects a user who authorized the App before
// without a prompt, so the owner's token would pass the check below and the
// installation would land on the team member's team. Two steps:
//
//   ?installation_id=&setup_action=&state=  (Setup URL, after installation)
//     installation_id comes from the query string, so anyone can put any value
//     there. Store nothing yet: send the user through GitHub's OAuth web flow.
//
//   ?code=&state=  (Callback URL, after the user authorized the App)
//     Exchange the code for a token acting as the user and store the
//     installation only if that user can access it.
githubAppRouter.get("/callback", async (c) => {
  const uiBase = process.env.UI_URL ?? "http://localhost:3000"
  const state = c.req.query("state")
  const code = c.req.query("code")

  if (!state) {
    return c.redirect(`${uiBase}/dashboard?error=github-app-missing-state`)
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  const claims = await consumeInstallState(db, state, code ? "authorize" : "install")
  if (!claims || !session || session.user.id !== claims.userId) {
    return c.redirect(`${uiBase}/dashboard?error=github-app-invalid-state`)
  }
  const { teamId, userId } = claims
  const teamPage = `${uiBase}/dashboard/teams/${teamId}?tab=credentials`

  // The state may be up to 10 minutes old; the user must still be on the team.
  if (!(await isTeamMember(db, teamId, userId))) {
    return c.redirect(`${uiBase}/dashboard?error=github-app-not-a-member`)
  }

  const client = githubAppClient()
  if (!client) {
    return c.redirect(`${teamPage}&error=github-app-callback-failed`)
  }

  if (!code) {
    if (c.req.query("setup_action") === "request") {
      // The user requested access that hasn't been approved yet.
      return c.redirect(`${teamPage}&github_app=pending`)
    }
    const installationId = c.req.query("installation_id")
    if (!installationId || !INSTALLATION_ID_RE.test(installationId)) {
      return c.redirect(`${teamPage}&error=github-app-no-installation`)
    }

    const pkce = createCodeVerifier()
    const next = await createInstallState(db, teamId, userId, { installationId, codeVerifier: pkce.verifier })
    return c.redirect(userAuthorizeUrl(client.clientId, callbackUrl(), next, pkce.challenge))
  }

  const installationId = claims.installationId!
  try {
    const userToken = await exchangeUserCode(client, code, callbackUrl(), claims.codeVerifier!)
    if (!(await userCanAccessInstallation(userToken, installationId))) {
      return c.redirect(`${teamPage}&error=github-app-not-authorized`)
    }

    const details = await getInstallationDetails(installationId)
    const accountLogin = details?.account?.login ?? installationId
    await upsertGithubAppInstallation(db, teamId, installationId, accountLogin, userId)
  } catch (err) {
    console.error("GitHub App callback error", err)
    return c.redirect(`${teamPage}&error=github-app-callback-failed`)
  }

  return c.redirect(`${teamPage}&github_app=installed`)
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
