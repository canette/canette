// Package env provides helpers for reading configuration from environment variables
// and Kubernetes-style secret file mounts.
package env

import (
	"fmt"
	"os"
	"strings"
)

// EnvOr returns the value of key if set and non-empty, otherwise def.
func EnvOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// RequireEnv returns the value of key (via ReadSecretOrEnv) or an error if unset.
func RequireEnv(key string) (string, error) {
	v := ReadSecretOrEnv(key)
	if v == "" {
		return "", fmt.Errorf("%s environment variable is required", key)
	}
	return v, nil
}

// ReadSecretOrEnv reads a secret value from a file if <KEY>_FILE is set,
// falling back to the plain environment variable. This supports both the
// Kubernetes file-mount pattern (production) and plain env vars (local dev).
func ReadSecretOrEnv(key string) string {
	if path := os.Getenv(key + "_FILE"); path != "" {
		if data, err := os.ReadFile(path); err == nil {
			return strings.TrimRight(string(data), "\n")
		}
	}
	return os.Getenv(key)
}
