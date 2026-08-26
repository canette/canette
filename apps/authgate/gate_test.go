package main

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const testPassword = "correct-horse-battery-staple"

func newTestGate(t *testing.T, upstream *httptest.Server) *gate {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("GenerateFromPassword: %v", err)
	}
	u, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream URL: %v", err)
	}
	cfg := config{
		Username:     "demo",
		PasswordHash: string(hash),
		UpstreamPort: u.Port(),
		AppSlug:      "my-app",
	}
	return newGate(cfg)
}

func basicAuthHeader(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func TestGate_BasicAuthSuccess(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("upstream-ok"))
	}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	req := httptest.NewRequest("GET", "/anything", nil)
	req.Header.Set("Authorization", basicAuthHeader("demo", testPassword))
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "upstream-ok" {
		t.Fatalf("got status=%d body=%q, want 200 upstream-ok", rec.Code, rec.Body.String())
	}
}

func TestGate_BasicAuthWrongPassword(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream should not be reached with a wrong password")
	}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	req := httptest.NewRequest("GET", "/anything", nil)
	req.Header.Set("Authorization", basicAuthHeader("demo", "wrong-password"))
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got status=%d, want 401", rec.Code)
	}
	if rec.Header().Get("WWW-Authenticate") == "" {
		t.Error("expected a WWW-Authenticate challenge header")
	}
}

func TestGate_NoAuthGETRedirectsToLoginForm(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream should not be reached without credentials")
	}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	req := httptest.NewRequest("GET", "/dashboard?tab=logs", nil)
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("got status=%d, want 302", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, gatePathPrefix+"login?return=") {
		t.Fatalf("unexpected redirect location %q", loc)
	}
	if !strings.Contains(loc, url.QueryEscape("/dashboard?tab=logs")) {
		t.Errorf("redirect location %q does not preserve the original path", loc)
	}
}

func TestGate_NoAuthNonGETChallenges(t *testing.T) {
	// Webhooks/CI/uptime checks (typically POST) get the same 401 challenge
	// the old Basic Auth sidecar always returned — no HTML redirect for them.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream should not be reached without credentials")
	}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	req := httptest.NewRequest("POST", "/webhook", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got status=%d, want 401", rec.Code)
	}
}

func TestGate_ValidSessionCookieProxies(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" {
			t.Error("upstream should never see the gate's own session cookie")
		}
		_, _ = w.Write([]byte("upstream-ok"))
	}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: signSession(g.cfg.PasswordHash, time.Now())})
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "upstream-ok" {
		t.Fatalf("got status=%d body=%q, want 200 upstream-ok", rec.Code, rec.Body.String())
	}
}

func TestGate_ExpiredSessionCookieDoesNotProxy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream should not be reached with an expired session")
	}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	expired := signSession(g.cfg.PasswordHash, time.Now().Add(-2*sessionTTL))
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: expired})
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("got status=%d, want 302 (fall through to login)", rec.Code)
	}
}

func TestGate_LoginSubmitSuccessSetsCookieAndRedirects(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	form := url.Values{"password": {testPassword}, "return": {"/dashboard"}}
	req := httptest.NewRequest("POST", gatePathPrefix+"login", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusSeeOther {
		t.Fatalf("got status=%d, want 303", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/dashboard" {
		t.Errorf("got Location=%q, want /dashboard", loc)
	}
	resp := rec.Result()
	var found bool
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookieName {
			found = true
			if !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode {
				t.Errorf("session cookie missing required attributes: %+v", c)
			}
		}
	}
	if !found {
		t.Error("expected a session cookie to be set")
	}
}

func TestGate_LoginSubmitWrongPasswordShowsError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	form := url.Values{"password": {"wrong"}, "return": {"/dashboard"}}
	req := httptest.NewRequest("POST", gatePathPrefix+"login", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status=%d, want 200 (re-render form with error)", rec.Code)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			t.Error("no session cookie should be set on a failed login")
		}
	}
	if !strings.Contains(rec.Body.String(), "accepted") {
		t.Error("expected a generic failure message in the response body")
	}
}

func TestGate_LoginSubmitRejectsUnsafeReturnPath(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	form := url.Values{"password": {testPassword}, "return": {"//evil.com"}}
	req := httptest.NewRequest("POST", gatePathPrefix+"login", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Errorf("got Location=%q, want / (unsafe return path rejected)", loc)
	}
}

func TestGate_Logout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	req := httptest.NewRequest("POST", gatePathPrefix+"logout", nil)
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusSeeOther {
		t.Fatalf("got status=%d, want 303", rec.Code)
	}
	var cleared bool
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("expected logout to clear the session cookie")
	}
}

func TestGate_Healthz(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	req := httptest.NewRequest("GET", gatePathPrefix+"healthz", nil)
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status=%d, want 200", rec.Code)
	}
}

func TestConfigUpstreamOrigin(t *testing.T) {
	c := config{UpstreamPort: "8080"}
	if got, want := c.upstreamOrigin(), "http://localhost:8080"; got != want {
		t.Errorf("upstreamOrigin() = %q, want %q", got, want)
	}
}

func TestVerifyPasswordRejectsWrongUsername(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("GenerateFromPassword: %v", err)
	}
	g := &gate{cfg: config{Username: "demo", PasswordHash: string(hash)}}
	if g.verifyPassword("someone-else", testPassword) {
		t.Error("expected verifyPassword to reject a mismatched username")
	}
	if !g.verifyPassword("demo", testPassword) {
		t.Error("expected verifyPassword to accept the correct username/password")
	}
}

func TestNoAuthNonGETMethodIsChallenged(t *testing.T) {
	// Sanity check the method guard covers more than just POST.
	for _, method := range []string{http.MethodPut, http.MethodDelete, http.MethodPatch} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Error("upstream should not be reached without credentials")
		}))
		g := newTestGate(t, upstream)

		req := httptest.NewRequest(method, "/resource/"+strconv.Itoa(1), nil)
		rec := httptest.NewRecorder()
		g.mux().ServeHTTP(rec, req)
		upstream.Close()

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("method %s: got status=%d, want 401", method, rec.Code)
		}
	}
}
