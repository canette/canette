import { Hono } from "hono"
import { auth } from "../auth/auth"
import {
  registerClient,
  getClient,
  issueAuthCode,
  exchangeAuthCode,
  issueAccessToken,
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
oauthRouter.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : []
  if (!redirectUris.length) {
    return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" }, 400)
  }

  const clientName = typeof body.client_name === "string" ? body.client_name : undefined
  const client = registerClient(redirectUris, clientName)

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

  // Reject non-http(s) redirect_uris (blocks javascript:, data:, etc.).
  // A crafted callbackURL could otherwise inject a malicious redirect_uri and,
  // since the attacker also chooses code_challenge, exchange the resulting code.
  try {
    const uri = new URL(redirect_uri)
    if (uri.protocol !== "http:" && uri.protocol !== "https:") {
      return c.json({ error: "invalid_request", error_description: "redirect_uri must use http or https" }, 400)
    }
  } catch {
    return c.json({ error: "invalid_request", error_description: "redirect_uri must be a valid URL" }, 400)
  }

  // Validate redirect_uri against the registered client if we still have the
  // registration in memory. Registrations are in-memory only, so they are lost
  // on restart — a missing registration is silently accepted (PKCE is the
  // security mechanism, not client identity).
  if (client_id) {
    const client = getClient(client_id)
    if (client && !client.redirectUris.includes(redirect_uri)) {
      return c.json({ error: "invalid_request", error_description: "redirect_uri not registered for this client" }, 400)
    }
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
  const q = c.req.query()
  const { client_id, response_type, code_challenge, code_challenge_method, redirect_uri, state } = q

  if (response_type !== "code") return c.json({ error: "unsupported_response_type" }, 400)
  if (!code_challenge || !redirect_uri) return c.json({ error: "invalid_request" }, 400)
  if (code_challenge_method !== "S256") return c.json({ error: "invalid_request" }, 400)

  try {
    const uri = new URL(redirect_uri)
    if (uri.protocol !== "http:" && uri.protocol !== "https:") return c.json({ error: "invalid_request" }, 400)
  } catch {
    return c.json({ error: "invalid_request" }, 400)
  }

  if (client_id) {
    const client = getClient(client_id)
    if (client && !client.redirectUris.includes(redirect_uri)) return c.json({ error: "invalid_request" }, 400)
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return c.json({ error: "unauthorized" }, 401)

  const code = issueAuthCode(session.user.id, code_challenge, redirect_uri)

  const redirectUrl = new URL(redirect_uri)
  redirectUrl.searchParams.set("code", code)
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

  const userId = exchangeAuthCode(code, code_verifier, redirect_uri)
  if (!userId) return c.json({ error: "invalid_grant" }, 400)

  const token = await issueAccessToken(userId)
  return c.json({ access_token: token, token_type: "Bearer", expires_in: 3600 })
})
