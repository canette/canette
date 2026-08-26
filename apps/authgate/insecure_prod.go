//go:build !localdev

package main

// insecureCookiesEnabled always reports false in the binary that ships in
// canette-authgate images. The Dockerfile builds without -tags=localdev, so
// this file — not insecure_local.go — is what's compiled into every
// production image, and AUTHGATE_INSECURE_COOKIES has no effect no matter
// what a deployed container's environment sets. Only
// `go run -tags=localdev .` (or `go test -tags=localdev ./...`) picks up
// insecure_local.go instead, for testing over plain HTTP.
func insecureCookiesEnabled() bool {
	return false
}
