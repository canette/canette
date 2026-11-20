package main

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestSafeReturnPath(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "/"},
		{"/dashboard", "/dashboard"},
		{"/dashboard?tab=logs", "/dashboard?tab=logs"},
		{"//evil.com", "/"},
		{"/\\evil.com", "/"},
		{"https://evil.com", "/"},
		{"http://evil.com", "/"},
		{"evil.com", "/"},
		{"/path\r\nInjected: header", "/"},
	}
	for _, c := range cases {
		if got := safeReturnPath(c.in); got != c.want {
			t.Errorf("safeReturnPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestLoginPageScriptMatchesCSP guards against the inline script and the CSP
// hash drifting apart, which would make the browser block the script and
// silently drop URL fragments again.
func TestLoginPageScriptMatchesCSP(t *testing.T) {
	rec := httptest.NewRecorder()
	renderLoginPage(rec, loginPageData{ReturnPath: "/"})

	m := regexp.MustCompile(`(?s)<script>(.*?)</script>`).FindStringSubmatch(rec.Body.String())
	if m == nil {
		t.Fatal("login page has no inline script")
	}
	sum := sha256.Sum256([]byte(m[1]))
	want := "script-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "';"
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, want) {
		t.Errorf("CSP %q does not allow the rendered script (want %q)", csp, want)
	}
}
