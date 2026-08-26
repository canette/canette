//go:build localdev

package main

import "os"

// insecureCookiesEnabled reads AUTHGATE_INSECURE_COOKIES=true to drop the
// Secure attribute — and the __Host- name prefix, which browsers require
// Secure for — so the session cookie survives local testing over plain HTTP.
// Only compiled in with -tags=localdev; see insecure_prod.go for the build
// that ships in the actual sidecar image.
func insecureCookiesEnabled() bool {
	return os.Getenv("AUTHGATE_INSECURE_COOKIES") == "true"
}
