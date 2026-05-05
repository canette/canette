import { createHash } from "crypto"
import { SignJWT } from "jose"

type StoredCode = {
  userId: string
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

export function issueAuthCode(userId: string, codeChallenge: string, redirectUri: string): string {
  const code = crypto.randomUUID()
  authCodes.set(code, {
    userId,
    codeChallenge,
    redirectUri,
    expiresAt: Date.now() + 5 * 60 * 1000,
  })
  setTimeout(() => authCodes.delete(code), 5 * 60 * 1000)
  return code
}

// Returns the userId on success, null if the code/verifier/redirect_uri is invalid.
export function exchangeAuthCode(code: string, codeVerifier: string, redirectUri: string): string | null {
  const stored = authCodes.get(code)
  if (!stored || Date.now() > stored.expiresAt) {
    authCodes.delete(code)
    return null
  }
  if (stored.redirectUri !== redirectUri) return null
  const verifierHash = createHash("sha256").update(codeVerifier).digest("base64url")
  if (verifierHash !== stored.codeChallenge) return null
  authCodes.delete(code)
  return stored.userId
}

export async function issueAccessToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .setIssuedAt()
    .sign(jwtSecret())
}
