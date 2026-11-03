// Decides which hosts a stored git credential may be sent to.
//
// A PAT or GitHub App token is sent to the app's git host on every clone (as an
// HTTP Authorization header) and to the provider's API during webhook
// registration. The git URL is user-controlled, so without this check anyone
// who can attach a credential to an app (including system-wide credentials,
// which every user can use) could point the app at their own server and
// capture the token.
//
// The same rules are enforced by the builder in Go
// (apps/builder/internal/gitdest) — keep the two in sync.

export const ALLOWED_ORIGINS_ENV = "GIT_CREDENTIAL_ALLOWED_ORIGINS"

// Built-in trusted git hosts, per credential provider.
const BUILTIN_GIT_ORIGINS: Record<string, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
}

// scp-style SSH URL: git@host:path (same shape the builder's git-init accepts).
const SCP_STYLE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/

interface CredentialLike {
  provider: string
  type: string
}

// Returns the origin of an `https://host[:port]` value, or null when the value
// has any other scheme, embedded credentials, a path, query or fragment.
export function normaliseHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

// True when an administrator listed `origin` in GIT_CREDENTIAL_ALLOWED_ORIGINS.
export function isAdminAllowedOrigin(origin: string): boolean {
  const configured = process.env[ALLOWED_ORIGINS_ENV] ?? ""
  return configured
    .split(",")
    .some((entry) => normaliseHttpsOrigin(entry.trim()) === origin)
}

// Returns a human-readable reason when `credential` must not be sent to the
// host in `gitUrl`, or null when it may be.
export function credentialDestinationError(credential: CredentialLike, gitUrl: string): string | null {
  // SSH keys never leave the build pod — only a signature is sent.
  if (credential.type === "ssh_key") return null

  // Tokens are only attached to HTTP(S) clones, so the two SSH forms never carry
  // them. Everything else fails closed: it must be a canonical https:// URL.
  const trimmed = gitUrl.trim()
  if (SCP_STYLE_RE.test(trimmed) || /^ssh:\/\//i.test(trimmed)) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return "The repository URL is not a valid URL"
  }
  if (url.protocol !== "https:") {
    return "Git credentials can only be used with https:// repository URLs"
  }
  // Reject anything the WHATWG parser would normalise into a different host
  // than other parsers (git/curl, Go) might see: userinfo, backslashes,
  // missing slashes. The raw authority must equal the parsed host.
  const rawAuthority = /^https:\/\/([^/?#]*)/i.exec(trimmed)?.[1]?.toLowerCase().replace(/:443$/, "")
  if (url.username || url.password || trimmed.includes("\\") || rawAuthority !== url.host) {
    return "The repository URL must be a plain https://host/owner/repo URL to use a git credential"
  }
  const origin = url.origin

  // GitHub App tokens are only valid for, and must only ever be sent to, GitHub.
  if (credential.type === "github_app") {
    return origin === BUILTIN_GIT_ORIGINS.github
      ? null
      : "GitHub App credentials can only be used with github.com repositories"
  }

  if (BUILTIN_GIT_ORIGINS[credential.provider] === origin) return null
  if (isAdminAllowedOrigin(origin)) return null

  return (
    `This git credential can't be used with ${origin}. Credentials are only sent to ` +
    `the provider's public host (github.com, gitlab.com) or to hosts an administrator ` +
    `has allowed via ${ALLOWED_ORIGINS_ENV}.`
  )
}
