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

// githubAppClient returns the GitHub App's OAuth client credentials, which the
// per-team installation wizard needs to verify who installed the App. Null when
// either is missing, in which case the wizard is unavailable.
export function githubAppClient(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_APP_CLIENT_ID
  const clientSecret = readSecretOrEnv("GITHUB_APP_CLIENT_SECRET")
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

// userAuthorizeUrl is the GitHub OAuth web-flow URL that asks the user to
// authorize the App, so the callback gets a token acting as that user. A user
// who has authorized the App before is sent straight back without a prompt.
export function userAuthorizeUrl(clientId: string, redirectUri: string, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  })
  return `https://github.com/login/oauth/authorize?${params}`
}

// exchangeUserCode trades the OAuth callback code for a user access token. The
// token is only used to list the user's installations and is never stored.
export async function exchangeUserCode(
  client: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  })
  // GitHub reports some failures (bad code, bad client secret) as 200 with an
  // error field, so check both.
  const data = await res.json().catch(() => ({})) as { access_token?: string; error?: string }
  if (!res.ok || !data.access_token) {
    throw new Error(`GitHub user token exchange failed (${res.status}): ${data.error ?? "no access_token"}`)
  }
  return data.access_token
}

const USER_INSTALLATIONS_MAX_PAGES = 10

// userCanAccessInstallation reports whether installationId is one of this
// App's installations that the user behind userToken can access. GitHub's
// guidance for the Setup URL: its installation_id can be spoofed, so check it
// against the installing user's own token before trusting it.
export async function userCanAccessInstallation(userToken: string, installationId: string): Promise<boolean> {
  const wanted = Number(installationId)
  for (let page = 1; page <= USER_INSTALLATIONS_MAX_PAGES; page++) {
    const res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`GitHub user installations lookup failed (${res.status}): ${body}`)
    }
    const data = await res.json() as { total_count: number; installations: Array<{ id: number }> }
    if (data.installations.some((i) => i.id === wanted)) return true
    if (data.installations.length < 100 || page * 100 >= data.total_count) return false
  }
  return false
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
