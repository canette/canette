package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"
)

// gate holds the wiring needed to serve one app's traffic: verify
// credentials (Basic Auth header or session cookie) and reverse-proxy
// authenticated requests to the app container on localhost.
type gate struct {
	cfg   config
	log   *zap.Logger
	proxy *httputil.ReverseProxy
}

func newGate(log *zap.Logger, cfg config) *gate {
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
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			// Log the real cause server-side (connection refused, timeout, ...) —
			// the upstream port isn't secret, just noise the browser doesn't need
			// and shouldn't be trusted to render safely. The client only ever
			// gets the generic message.
			log.Warn("upstream proxy error",
				zap.Error(err), zap.String("upstreamPort", cfg.UpstreamPort))
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
		},
	}
	return &gate{cfg: cfg, log: log, proxy: proxy}
}

func (g *gate) mux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+gatePathPrefix+"healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET "+gatePathPrefix+"login", g.handleLoginForm)
	mux.HandleFunc("POST "+gatePathPrefix+"login", g.handleLoginSubmit)
	mux.HandleFunc("GET "+gatePathPrefix+"logout", g.handleLogout)
	mux.HandleFunc("POST "+gatePathPrefix+"logout", g.handleLogout)
	// Catch-all for the reserved gate namespace: a method/path under
	// gatePathPrefix that isn't one of the exact routes above (e.g. PUT on
	// /login, or a typo'd subpath) must still never fall through to
	// handleProxy below and reach the app — Go's ServeMux always prefers a
	// more specific method+path match over this subtree pattern, so this
	// only catches genuine gaps.
	mux.HandleFunc(gatePathPrefix, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	mux.HandleFunc("/", g.handleProxy)
	return mux
}

// handleProxy is the catch-all: verify the request, then either proxy it
// upstream or challenge for credentials.
func (g *gate) handleProxy(w http.ResponseWriter, r *http.Request) {
	if _, pass, ok := r.BasicAuth(); ok {
		if g.verifyPassword(pass) {
			g.proxy.ServeHTTP(w, r)
			return
		}
		g.challengeBasicAuth(w)
		return
	}

	if cookie, err := r.Cookie(currentSessionCookieName()); err == nil {
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

// verifyPassword checks the password only — any username is accepted
// alongside it (see the config doc comment for why).
func (g *gate) verifyPassword(pass string) bool {
	return bcrypt.CompareHashAndPassword([]byte(g.cfg.PasswordHash), []byte(pass)) == nil
}

func (g *gate) handleLoginForm(w http.ResponseWriter, r *http.Request) {
	renderLoginPage(w, loginPageData{
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
			ReturnPath:   returnPath,
			ErrorMessage: "Incorrect password, please try again.",
		})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     currentSessionCookieName(),
		Value:    signSession(g.cfg.PasswordHash, time.Now()),
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		Secure:   !insecureCookiesEnabled(),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, returnPath, http.StatusSeeOther)
}

func (g *gate) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     currentSessionCookieName(),
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Secure:   !insecureCookiesEnabled(),
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
