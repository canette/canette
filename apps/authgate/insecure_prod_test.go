//go:build !localdev

package main

import "testing"

// This is the build every canette-authgate image ships (the Dockerfile never
// passes -tags=localdev) — proves AUTHGATE_INSECURE_COOKIES cannot weaken a
// real deployment no matter what a container's environment sets.
func TestInsecureCookiesDisabledWithoutLocaldevTag(t *testing.T) {
	t.Setenv("AUTHGATE_INSECURE_COOKIES", "true")
	if insecureCookiesEnabled() {
		t.Fatal("insecureCookiesEnabled() must always be false without the localdev build tag, even with the env var set")
	}
	if got := currentSessionCookieName(); got != sessionCookieName {
		t.Errorf("currentSessionCookieName() = %q, want %q", got, sessionCookieName)
	}
}
