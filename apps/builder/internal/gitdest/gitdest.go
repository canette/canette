// Package gitdest decides which hosts a stored git credential may be sent to.
//
// A PAT or GitHub App token is attached to the clone request as an HTTP
// Authorization header. The app's git URL is user-controlled, so without this
// check anyone who can attach a credential to an app (including system-wide
// credentials, which every user can use) could point the app at their own
// server and capture the token.
//
// The same rules are enforced by the API in TypeScript
// (apps/api/src/services/git-credential-destination.ts) — keep the two in sync.
package gitdest

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// AllowedOriginsEnv lists extra https origins (comma-separated) that
// credentials may be sent to, e.g. self-hosted Gitea or GitLab instances.
const AllowedOriginsEnv = "GIT_CREDENTIAL_ALLOWED_ORIGINS"

const githubOrigin = "https://github.com"

// scpStyleRe matches scp-style SSH URLs (git@host:path), same shape the
// git-init container accepts.
var scpStyleRe = regexp.MustCompile(`^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+$`)

// builtinOrigins are the trusted public hosts, per credential provider.
var builtinOrigins = map[string]string{
	"github": githubOrigin,
	"gitlab": "https://gitlab.com",
}

// normaliseHTTPSOrigin returns "https://host[:port]" for a bare https origin,
// or "" when the value has another scheme, embedded credentials, a path,
// query or fragment. The default port is dropped and the host lowercased to
// match the WHATWG URL origin the API computes.
func normaliseHTTPSOrigin(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return ""
	}
	return originOf(u)
}

func originOf(u *url.URL) string {
	host := strings.ToLower(u.Host)
	host = strings.TrimSuffix(host, ":443")
	return "https://" + host
}

func adminAllowed(origin string) bool {
	for _, entry := range strings.Split(os.Getenv(AllowedOriginsEnv), ",") {
		if n := normaliseHTTPSOrigin(strings.TrimSpace(entry)); n != "" && n == origin {
			return true
		}
	}
	return false
}

// Check returns an error when a credential of the given provider and type must
// not be sent to the host in gitURL.
func Check(provider, credType, gitURL string) error {
	// SSH keys never leave the build pod — only a signature is sent.
	if credType == "ssh_key" {
		return nil
	}

	// Tokens are only attached to HTTP(S) clones, so the two SSH forms never
	// carry them. Everything else fails closed: it must be a canonical https URL.
	trimmed := strings.TrimSpace(gitURL)
	if scpStyleRe.MatchString(trimmed) || strings.HasPrefix(strings.ToLower(trimmed), "ssh://") {
		return nil
	}

	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" {
		return fmt.Errorf("the repository URL is not a valid URL")
	}
	if u.Scheme != "https" {
		return fmt.Errorf("git credentials can only be used with https:// repository URLs")
	}
	// Reject anything other parsers (git/curl, the API's WHATWG parser) might
	// resolve to a different host: userinfo, backslashes, opaque forms.
	if u.User != nil || u.Opaque != "" || strings.Contains(trimmed, "\\") ||
		!strings.HasPrefix(trimmed, "https://"+u.Host) {
		return fmt.Errorf("the repository URL must be a plain https://host/owner/repo URL to use a git credential")
	}
	origin := originOf(u)

	// GitHub App tokens are only valid for, and must only ever be sent to, GitHub.
	if credType == "github_app" {
		if origin == githubOrigin {
			return nil
		}
		return fmt.Errorf("GitHub App credentials can only be used with github.com repositories")
	}

	if builtinOrigins[provider] == origin || adminAllowed(origin) {
		return nil
	}
	return fmt.Errorf(
		"this git credential can't be used with %s: credentials are only sent to the provider's "+
			"public host (github.com, gitlab.com) or to hosts an administrator has allowed via %s",
		origin, AllowedOriginsEnv)
}
