import { createHash } from "crypto"
import { SignJWT } from "jose"

type StoredCode = {
  userId: string
  sessionId: string
  codeChallenge: string
  redirectUri: string
  expiresAt: number
}

export type RegisteredClient = {
  clientId: string
  redirectUris: string[]
  clientName?: string
}

const authCodes = new Map<string, StoredCode>()
// Insertion-ordered, and getClient re-inserts on use, so the first entry is
// always the least recently used one.
const registeredClients = new Map<string, RegisteredClient & { expiresAt: number }>()

// /oauth/register is unauthenticated, so everything it stores is bounded:
// at most MAX_CLIENTS × MAX_REDIRECT_URIS × MAX_REDIRECT_URI_LENGTH bytes of
// URIs (~20 MB). A registration expires CLIENT_TTL_MS after its last use, and
// when the store is full the least recently used one is evicted. Losing a
// registration is harmless: it is treated like one lost on restart.
export const MAX_CLIENTS = 1000
export const MAX_REDIRECT_URIS = 10
export const MAX_REDIRECT_URI_LENGTH = 2048
export const MAX_CLIENT_NAME_LENGTH = 200
const CLIENT_TTL_MS = 24 * 60 * 60 * 1000

export function jwtSecret(): Uint8Array {
  const secret = process.env.MCP_JWT_SECRET
  if (!secret) throw new Error("MCP_JWT_SECRET is not set")
  return new TextEncoder().encode(secret)
}

// Validates RFC 7591 client metadata. Returns the error_description for an
// invalid_client_metadata response, or the parsed metadata.
export function parseClientMetadata(
  body: Record<string, unknown>
): { error: string } | { redirectUris: string[]; clientName?: string } {
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0) return { error: "redirect_uris is required" }
  if (uris.length > MAX_REDIRECT_URIS) return { error: `at most ${MAX_REDIRECT_URIS} redirect_uris are allowed` }
  for (const uri of uris) {
    if (typeof uri !== "string" || uri.length > MAX_REDIRECT_URI_LENGTH || !isHttpUrl(uri)) {
      return { error: `every redirect_uri must be an http(s) URL of at most ${MAX_REDIRECT_URI_LENGTH} characters` }
    }
  }

  const name = body.client_name
  if (name !== undefined && typeof name !== "string") return { error: "client_name must be a string" }
  if (name !== undefined && name.length > MAX_CLIENT_NAME_LENGTH) {
    return { error: `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters` }
  }
  return { redirectUris: uris as string[], clientName: name }
}

export function registerClient(redirectUris: string[], clientName?: string): RegisteredClient {
  const now = Date.now()
  for (const [id, client] of registeredClients) {
    if (client.expiresAt > now) break
    registeredClients.delete(id)
  }
  while (registeredClients.size >= MAX_CLIENTS) {
    const oldest = registeredClients.keys().next().value
    if (oldest === undefined) break
    registeredClients.delete(oldest)
  }

  const clientId = crypto.randomUUID()
  const client: RegisteredClient = { clientId, redirectUris, clientName }
  registeredClients.set(clientId, { ...client, expiresAt: now + CLIENT_TTL_MS })
  return client
}

export function getClient(clientId: string): RegisteredClient | undefined {
  const stored = registeredClients.get(clientId)
  if (!stored) return undefined
  registeredClients.delete(clientId)
  if (stored.expiresAt <= Date.now()) return undefined
  stored.expiresAt = Date.now() + CLIENT_TTL_MS
  registeredClients.set(clientId, stored)
  return { clientId: stored.clientId, redirectUris: stored.redirectUris, clientName: stored.clientName }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

// Checks a redirect_uri before anything is sent to it: http(s) only (blocks
// javascript:, data:, etc.), and one of the client's registered URIs if the
// registration is still in memory. A missing registration is accepted — they
// are lost on restart, and PKCE, not client identity, is the security
// mechanism. Returns an error_description, or null when the URI is usable.
export function checkRedirectUri(redirectUri: string | undefined, clientId: string | undefined): string | null {
  if (!redirectUri) return "redirect_uri is required"
  if (!isHttpUrl(redirectUri)) return "redirect_uri must be a valid http or https URL"
  if (clientId) {
    const client = getClient(clientId)
    if (client && !client.redirectUris.includes(redirectUri)) return "redirect_uri not registered for this client"
  }
  return null
}

export function issueAuthCode(userId: string, sessionId: string, codeChallenge: string, redirectUri: string): string {
  const code = crypto.randomUUID()
  authCodes.set(code, {
    userId,
    sessionId,
    codeChallenge,
    redirectUri,
    expiresAt: Date.now() + 5 * 60 * 1000,
  })
  setTimeout(() => authCodes.delete(code), 5 * 60 * 1000)
  return code
}

// Returns the user and the web session that authorized the code on success,
// null if the code/verifier/redirect_uri is invalid.
export function exchangeAuthCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): { userId: string; sessionId: string } | null {
  const stored = authCodes.get(code)
  if (!stored || Date.now() > stored.expiresAt) {
    authCodes.delete(code)
    return null
  }
  if (stored.redirectUri !== redirectUri) return null
  const verifierHash = createHash("sha256").update(codeVerifier).digest("base64url")
  if (verifierHash !== stored.codeChallenge) return null
  authCodes.delete(code)
  return { userId: stored.userId, sessionId: stored.sessionId }
}

// The token is bound (sid) to the web session that authorized it, so it stops
// working as soon as that session ends — see requireBearer.
export async function issueAccessToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sub: userId, sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .setIssuedAt()
    .sign(jwtSecret())
}

// isCrossOriginBrowserRequest reports whether a request was sent by a browser
// from a page other than the UI. Browsers attach Origin to every cross-origin
// POST and Sec-Fetch-Site to every request; the UI's server-to-server calls
// carry neither. Used to keep endpoints that are only ever called by the UI
// server from being driven by a form on another page.
export function isCrossOriginBrowserRequest(headers: Headers, uiUrl: string): boolean {
  const fetchSite = headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return true

  const origin = headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin !== new URL(uiUrl).origin
  } catch {
    return true
  }
}
