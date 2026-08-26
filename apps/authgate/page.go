package main

import (
	"html/template"
	"net/http"
	"strings"
)

// gatePathPrefix is reserved for the gate's own endpoints and is never
// forwarded to the app — mirrors how the old Caddy sidecar's basic_auth
// directive owned the whole origin, just scoped to one prefix now that the
// gate also serves a login page.
const gatePathPrefix = "/.canette-gate/"

var loginTemplate = template.Must(template.New("login").Parse(loginPageHTML))

type loginPageData struct {
	ReturnPath   string
	ErrorMessage string
}

func renderLoginPage(w http.ResponseWriter, data loginPageData) {
	setGatePageHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = loginTemplate.Execute(w, data)
}

func setGatePageHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
}

// safeReturnPath restricts login/logout redirect targets to a single
// relative path on this origin. Rejects anything that could send the
// browser off-site after a successful login: absolute URLs, protocol-
// relative URLs ("//evil.com"), backslash tricks, and anything not
// starting with exactly one "/".
func safeReturnPath(raw string) string {
	const fallback = "/"
	if raw == "" {
		return fallback
	}
	if !strings.HasPrefix(raw, "/") {
		return fallback
	}
	if strings.HasPrefix(raw, "//") || strings.HasPrefix(raw, "/\\") {
		return fallback
	}
	if strings.ContainsAny(raw, "\r\n\t") {
		return fallback
	}
	return raw
}

const loginPageHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authentication required</title>
<style>
  body {
    margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #000; color: #ededed;
  }
  main { width: 100%; max-width: 20rem; padding: 1.5rem; box-sizing: border-box; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.35rem; }
  p.sub { margin: 0 0 1.5rem; font-size: 0.9rem; color: #999; }
  label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 0.4rem; }
  /* font-size stays >=16px so iOS Safari doesn't zoom in on focus. */
  input[type=password] {
    width: 100%; box-sizing: border-box; padding: 0.75rem; font-size: 1rem;
    border: 1px solid #333; border-radius: 0.5rem; background: #141414; color: inherit;
  }
  input[type=password]:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }
  button {
    width: 100%; margin-top: 1rem; padding: 0.75rem; font-size: 1rem; font-weight: 500;
    border: none; border-radius: 0.5rem; cursor: pointer; background: #ededed; color: #0a0a0a;
  }
  button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  .error {
    margin: 0 0 1rem; padding: 0.65rem 0.8rem; font-size: 0.85rem; border-radius: 0.5rem;
    background: #2a1414; color: #f87171;
  }
</style>
</head>
<body>
<main>
  <h1>Authentication required</h1>
  <p class="sub">Enter the password to continue.</p>
  {{if .ErrorMessage}}<p class="error">{{.ErrorMessage}}</p>{{end}}
  <form method="post" action="/.canette-gate/login">
    <input type="hidden" name="return" value="{{.ReturnPath}}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Continue</button>
  </form>
</main>
</body>
</html>
`
