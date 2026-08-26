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
	AppSlug      string
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
<title>{{if .AppSlug}}{{.AppSlug}} — {{end}}Protected</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: light-dark(#f5f5f5, #0a0a0a); color: light-dark(#1a1a1a, #ededed);
  }
  main {
    width: 100%; max-width: 22rem; margin: 1.5rem; padding: 2rem;
    border: 1px solid light-dark(#e5e5e5, #262626); border-radius: 0.75rem;
    background: light-dark(#ffffff, #141414);
  }
  h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 0.35rem; }
  p.sub { margin: 0 0 1.25rem; font-size: 0.875rem; color: light-dark(#666, #999); }
  label { display: block; font-size: 0.8rem; font-weight: 500; margin-bottom: 0.4rem; }
  input[type=password] {
    width: 100%; box-sizing: border-box; padding: 0.55rem 0.7rem; font-size: 0.9rem;
    border: 1px solid light-dark(#d4d4d4, #333); border-radius: 0.4rem;
    background: light-dark(#fff, #1a1a1a); color: inherit;
  }
  input[type=password]:focus { outline: 2px solid light-dark(#2563eb, #3b82f6); outline-offset: 1px; }
  button {
    width: 100%; margin-top: 1rem; padding: 0.6rem; font-size: 0.9rem; font-weight: 500;
    border: none; border-radius: 0.4rem; cursor: pointer;
    background: light-dark(#1a1a1a, #ededed); color: light-dark(#fff, #0a0a0a);
  }
  button:focus-visible { outline: 2px solid light-dark(#2563eb, #3b82f6); outline-offset: 2px; }
  .error {
    margin: 0 0 1rem; padding: 0.6rem 0.75rem; font-size: 0.8rem; border-radius: 0.4rem;
    background: light-dark(#fef2f2, #2a1414); color: light-dark(#b91c1c, #f87171);
  }
</style>
</head>
<body>
<main>
  <h1>{{if .AppSlug}}{{.AppSlug}}{{else}}This app{{end}} is password protected</h1>
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
