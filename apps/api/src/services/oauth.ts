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
const registeredClients = new Map<string, RegisteredClient>()

export function jwtSecret(): Uint8Array {
  const secret = process.env.MCP_JWT_SECRET
  if (!secret) throw new Error("MCP_JWT_SECRET is not set")
  return new TextEncoder().encode(secret)
}

export function registerClient(redirectUris: string[], clientName?: string): RegisteredClient {
  const clientId = crypto.randomUUID()
  const client: RegisteredClient = { clientId, redirectUris, clientName }
  registeredClients.set(clientId, client)
  return client
}

export function getClient(clientId: string): RegisteredClient | undefined {
  return registeredClients.get(clientId)
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
