package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// gate holds the wiring needed to serve one app's traffic: verify
// credentials (Basic Auth header or session cookie) and reverse-proxy
// authenticated requests to the app container on localhost.
type gate struct {
	cfg   config
	proxy *httputil.ReverseProxy
}

func newGate(cfg config) *gate {
	target, err := url.Parse(cfg.upstreamOrigin())
	if err != nil {
		// cfg.UpstreamPort is validated as non-empty by loadConfig; a malformed
		// port would fail startup loudly rather than silently misroute traffic.
		panic("authgate: invalid upstream URL: " + err.Error())
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Never forward our own session cookie to the app — it's only
			// meaningful to the gate, and the app has no use for it.
			pr.Out.Header.Del("Cookie")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			// Never leak the upstream address or a Go error string to the browser.
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
		},
	}
	return &gate{cfg: cfg, proxy: proxy}
}

func (g *gate) mux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+gatePathPrefix+"healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET "+gatePathPrefix+"login", g.handleLoginForm)
	mux.HandleFunc("POST "+gatePathPrefix+"login", g.handleLoginSubmit)
	mux.HandleFunc("POST "+gatePathPrefix+"logout", g.handleLogout)
	mux.HandleFunc("/", g.handleProxy)
	return mux
}

// handleProxy is the catch-all: verify the request, then either proxy it
// upstream or challenge for credentials.
func (g *gate) handleProxy(w http.ResponseWriter, r *http.Request) {
	if user, pass, ok := r.BasicAuth(); ok {
		if g.verifyPassword(user, pass) {
			g.proxy.ServeHTTP(w, r)
			return
		}
		g.challengeBasicAuth(w)
		return
	}

	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		if verifySession(cookie.Value, g.cfg.PasswordHash, time.Now()) == nil {
			g.proxy.ServeHTTP(w, r)
			return
		}
	}

	// Browsers get the branded form; anything else (webhooks, uptime checks,
	// scripted API clients that don't send Basic Auth) gets the same 401 +
	// WWW-Authenticate challenge the old Basic Auth sidecar always returned —
	// no behavior change for non-browser callers.
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		target := gatePathPrefix + "login?return=" + url.QueryEscape(requestPath(r))
		http.Redirect(w, r, target, http.StatusFound)
		return
	}
	g.challengeBasicAuth(w)
}

func (g *gate) challengeBasicAuth(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="Restricted", charset="UTF-8"`)
	http.Error(w, "Unauthorized", http.StatusUnauthorized)
}

func (g *gate) verifyPassword(user, pass string) bool {
	if user != g.cfg.Username {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(g.cfg.PasswordHash), []byte(pass)) == nil
}

func (g *gate) handleLoginForm(w http.ResponseWriter, r *http.Request) {
	renderLoginPage(w, loginPageData{
		AppSlug:    g.cfg.AppSlug,
		ReturnPath: safeReturnPath(r.URL.Query().Get("return")),
	})
}

func (g *gate) handleLoginSubmit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	returnPath := safeReturnPath(r.PostForm.Get("return"))

	// bcrypt.CompareHashAndPassword's own cost-driven work factor is the rate
	// limit here (~100ms+ per attempt at cost 10) — see the plan's note on
	// deliberately not adding a second, separate rate-limiting layer for v1.
	if bcrypt.CompareHashAndPassword([]byte(g.cfg.PasswordHash), []byte(r.PostForm.Get("password"))) != nil {
		renderLoginPage(w, loginPageData{
			AppSlug:      g.cfg.AppSlug,
			ReturnPath:   returnPath,
			ErrorMessage: "That password wasn't accepted.",
		})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    signSession(g.cfg.PasswordHash, time.Now()),
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, returnPath, http.StatusSeeOther)
}

func (g *gate) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, gatePathPrefix+"login", http.StatusSeeOther)
}

// requestPath reconstructs the path+query of the original blocked request,
// used as the login page's "return" target.
func requestPath(r *http.Request) string {
	if r.URL.RawQuery == "" {
		return r.URL.Path
	}
	return r.URL.Path + "?" + r.URL.RawQuery
}
