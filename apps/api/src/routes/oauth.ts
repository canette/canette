import { Hono } from "hono"
import { auth } from "../auth/auth"
import {
  registerClient,
  getClient,
  parseClientMetadata,
  checkRedirectUri,
  issueAuthCode,
  exchangeAuthCode,
  issueAccessToken,
  isCrossOriginBrowserRequest,
} from "../services/oauth"

export const wellKnownRouter = new Hono()
export const oauthRouter = new Hono()

function publicBase(c: { req: { header: (name: string) => string | undefined; url: string } }): string {
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost:3001"
  return `${proto}://${host}`
}

// Public endpoint so the UI consent page can display the registered client name.
oauthRouter.get("/clients/:clientId", (c) => {
  const client = getClient(c.req.param("clientId"))
  return c.json({ clientName: client?.clientName ?? null })
})

wellKnownRouter.get("/oauth-authorization-server", (c) => {
  const base = publicBase(c)
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  })
})

// Dynamic client registration (RFC 7591) — required by the MCP OAuth spec.
// Registrations are intentionally in-memory only and not persisted to the
// database. Each MCP client (Claude Code, Cursor, Inspector) registers fresh
// per session, so persisted entries would only accumulate stale rows with no
// natural cleanup story. Security relies on PKCE (S256), not client identity:
// an intercepted auth code is useless without the code_verifier held by the
// legitimate client. redirect_uri is validated at token exchange against what
// was stored with the auth code, which closes the main redirect attack vector.
// The endpoint is unauthenticated, so the metadata and the store are bounded
// (see parseClientMetadata and registerClient).
oauthRouter.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null)
  const metadata = parseClientMetadata(body && typeof body === "object" ? (body as Record<string, unknown>) : {})
  if ("error" in metadata) {
    return c.json({ error: "invalid_client_metadata", error_description: metadata.error }, 400)
  }

  const client = registerClient(metadata.redirectUris, metadata.clientName)

  return c.json({
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: client.redirectUris,
    client_name: client.clientName,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  }, 201)
})

oauthRouter.get("/authorize", async (c) => {
  const q = c.req.query()
  const { client_id, response_type, code_challenge, code_challenge_method, redirect_uri } = q

  if (response_type !== "code") {
    return c.json({ error: "unsupported_response_type" }, 400)
  }
  if (!code_challenge || !redirect_uri) {
    return c.json({ error: "invalid_request", error_description: "code_challenge and redirect_uri are required" }, 400)
  }
  if (code_challenge_method !== "S256") {
    return c.json({ error: "invalid_request", error_description: "Only S256 PKCE is supported" }, 400)
  }

  // A crafted callbackURL could otherwise inject a malicious redirect_uri and,
  // since the attacker also chooses code_challenge, exchange the resulting code.
  const redirectError = checkRedirectUri(redirect_uri, client_id)
  if (redirectError) {
    return c.json({ error: "invalid_request", error_description: redirectError }, 400)
  }

  // Always send the browser to the UI consent page — code issuance happens
  // only after the user explicitly clicks Authorize (POST /oauth/confirm).
  const uiUrl = process.env.UI_URL ?? "http://localhost:3000"
  const params = new URL(c.req.url).searchParams.toString()
  return c.redirect(`${uiUrl}/oauth/authorize?${params}`)
})

// Called by the UI consent page server action after the user clicks Authorize.
// Re-validates all OAuth params, checks session, and issues the auth code.
oauthRouter.post("/confirm", async (c) => {
  // This endpoint is only ever called server-to-server by the UI's consent
  // action. A browser request from any other page must never reach it — the
  // session cookie alone is not proof that the user saw the consent screen.
  if (isCrossOriginBrowserRequest(c.req.raw.headers, process.env.UI_URL ?? "http://localhost:3000")) {
    return c.json({ error: "access_denied" }, 403)
  }

  const q = c.req.query()
  const { client_id, response_type, code_challenge, code_challenge_method, redirect_uri, state } = q

  if (response_type !== "code") return c.json({ error: "unsupported_response_type" }, 400)
  if (!code_challenge || !redirect_uri) return c.json({ error: "invalid_request" }, 400)
  if (code_challenge_method !== "S256") return c.json({ error: "invalid_request" }, 400)
  if (checkRedirectUri(redirect_uri, client_id)) return c.json({ error: "invalid_request" }, 400)

  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return c.json({ error: "unauthorized" }, 401)

  const code = issueAuthCode(session.user.id, session.session.id, code_challenge, redirect_uri)

  const redirectUrl = new URL(redirect_uri)
  redirectUrl.searchParams.set("code", code)
  if (state) redirectUrl.searchParams.set("state", state)
  return c.redirect(redirectUrl.toString())
})

// Called by the UI consent page server action after the user clicks Cancel.
// The consent page can be opened directly, without going through
// GET /oauth/authorize, so the redirect_uri is validated here too — otherwise
// Cancel would be an open redirect from the canette origin.
oauthRouter.post("/deny", (c) => {
  if (isCrossOriginBrowserRequest(c.req.raw.headers, process.env.UI_URL ?? "http://localhost:3000")) {
    return c.json({ error: "access_denied" }, 403)
  }

  const { client_id, redirect_uri, state } = c.req.query()
  if (checkRedirectUri(redirect_uri, client_id)) return c.json({ error: "invalid_request" }, 400)

  const redirectUrl = new URL(redirect_uri)
  redirectUrl.searchParams.set("error", "access_denied")
  redirectUrl.searchParams.set("error_description", "The user denied the authorization request")
  if (state) redirectUrl.searchParams.set("state", state)
  return c.redirect(redirectUrl.toString())
})

oauthRouter.post("/token", async (c) => {
  let params: Record<string, string> = {}
  const ct = c.req.header("content-type") ?? ""
  if (ct.includes("application/x-www-form-urlencoded")) {
    const raw = await c.req.parseBody()
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") params[k] = v
    }
  } else {
    params = await c.req.json()
  }

  const { grant_type, code, code_verifier, redirect_uri } = params

  if (grant_type !== "authorization_code") {
    return c.json({ error: "unsupported_grant_type" }, 400)
  }
  if (!code || !code_verifier || !redirect_uri) {
    return c.json({ error: "invalid_request", error_description: "code, code_verifier, and redirect_uri are required" }, 400)
  }

  const grant = exchangeAuthCode(code, code_verifier, redirect_uri)
  if (!grant) return c.json({ error: "invalid_grant" }, 400)

  const token = await issueAccessToken(grant.userId, grant.sessionId)
  return c.json({ access_token: token, token_type: "Bearer", expires_in: 3600 })
})
