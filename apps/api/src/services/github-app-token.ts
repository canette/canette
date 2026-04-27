import { readFileSync } from "node:fs"
import { createSign } from "node:crypto"

// readSecretOrEnv reads from a file if <KEY>_FILE is set, else falls back to
// the plain env var. Supports Kubernetes file-mount (production) and env vars (local dev).
function readSecretOrEnv(key: string): string | undefined {
  const filePath = process.env[`${key}_FILE`]
  if (filePath) {
    try {
      return readFileSync(filePath, "utf8").trimEnd()
    } catch {}
  }
  return process.env[key]
}

// generateInstallationToken mints a GitHub App installation access token.
// installationId: if provided, uses that installation; otherwise falls back to
// GITHUB_APP_INSTALLATION_ID env var (system credential mode).
// The returned token is valid for 1 hour and can be used as a Bearer token or as
// x-access-token in git clone URLs, identical to a PAT.
export async function generateInstallationToken(installationId?: string): Promise<string> {
  const appId = process.env.GITHUB_APP_ID
  const resolvedInstallationId = installationId ?? process.env.GITHUB_APP_INSTALLATION_ID
  const privateKey = readSecretOrEnv("GITHUB_APP_PRIVATE_KEY")

  if (!appId || !resolvedInstallationId || !privateKey) {
    throw new Error("GitHub App not configured (missing GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, or GITHUB_APP_PRIVATE_KEY)")
  }

  const jwt = signJwt(appId, privateKey)

  const res = await fetch(
    `https://api.github.com/app/installations/${resolvedInstallationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  )

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`GitHub App token exchange failed (${res.status}): ${body}`)
  }

  const data = await res.json() as { token: string }
  return data.token
}

// getInstallationDetails fetches GitHub App installation metadata using the app JWT.
// Used by the callback to determine which account/org the installation belongs to.
export async function getInstallationDetails(installationId: string): Promise<{ account: { login: string; type: string } }> {
  const appId = process.env.GITHUB_APP_ID
  const privateKey = readSecretOrEnv("GITHUB_APP_PRIVATE_KEY")

  if (!appId || !privateKey) {
    throw new Error("GitHub App not configured (missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY)")
  }

  const jwt = signJwt(appId, privateKey)

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  )

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`GitHub App installation lookup failed (${res.status}): ${body}`)
  }

  return res.json() as Promise<{ account: { login: string; type: string } }>
}

// signJwt creates a short-lived RS256 JWT for authenticating as the GitHub App.
// iat is backdated 60 s to account for clock skew; exp is 9 minutes from now.
function signJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64url(JSON.stringify({ iss: appId, iat: now - 60, exp: now + 540 }))
  const signingInput = `${header}.${payload}`
  const sign = createSign("RSA-SHA256")
  sign.update(signingInput)
  const signature = sign.sign(privateKeyPem, "base64url")
  return `${signingInput}.${signature}`
}

function base64url(s: string): string {
  return Buffer.from(s).toString("base64url")
}
