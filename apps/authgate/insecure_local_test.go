//go:build localdev

package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Only runs with `go test -tags=localdev ./...` — verifies the local-only
// opt-out actually works when deliberately enabled, mirroring
// TestInsecureCookiesDisabledWithoutLocaldevTag's proof that it's a no-op
// everywhere else.
func TestInsecureCookiesEnabledWithLocaldevTagAndEnvVar(t *testing.T) {
	t.Setenv("AUTHGATE_INSECURE_COOKIES", "true")
	if !insecureCookiesEnabled() {
		t.Fatal("expected insecureCookiesEnabled() to be true with the localdev tag and env var set")
	}
	if got := currentSessionCookieName(); got != insecureSessionCookieName {
		t.Errorf("currentSessionCookieName() = %q, want %q", got, insecureSessionCookieName)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	g := newTestGate(t, upstream)

	form := url.Values{"password": {testPassword}, "return": {"/dashboard"}}
	req := httptest.NewRequest("POST", gatePathPrefix+"login", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	g.mux().ServeHTTP(rec, req)

	var found bool
	for _, c := range rec.Result().Cookies() {
		if c.Name == insecureSessionCookieName {
			found = true
			if c.Secure {
				t.Error("expected Secure=false on the session cookie in insecure mode")
			}
		}
	}
	if !found {
		t.Fatalf("expected a %q cookie to be set", insecureSessionCookieName)
	}
}

func TestInsecureCookiesDisabledByDefaultEvenWithLocaldevTag(t *testing.T) {
	// The tag alone isn't enough — the env var still has to be set explicitly.
	if insecureCookiesEnabled() {
		t.Fatal("expected insecureCookiesEnabled() to be false when AUTHGATE_INSECURE_COOKIES is unset")
	}
}
