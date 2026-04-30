// Package githubapp provides installation token generation for GitHub Apps.
// It uses only the Go standard library — no third-party JWT dependency.
package githubapp

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// GenerateInstallationToken mints a GitHub App installation access token.
// installationID: if non-empty, uses that installation directly (per-team credential).
// Otherwise falls back to the GITHUB_APP_INSTALLATION_ID env var (system credential).
// The returned token is valid for 1 hour and is used as x-access-token in git
// clone URLs, identical to a PAT.
func GenerateInstallationToken(ctx context.Context, installationID string) (string, error) {
	appID := os.Getenv("GITHUB_APP_ID")
	resolvedInstallID := installationID
	if resolvedInstallID == "" {
		resolvedInstallID = os.Getenv("GITHUB_APP_INSTALLATION_ID")
	}
	privateKeyPEM := readSecretOrEnv("GITHUB_APP_PRIVATE_KEY")

	var missing []string
	if appID == "" {
		missing = append(missing, "GITHUB_APP_ID")
	}
	if resolvedInstallID == "" {
		missing = append(missing, "GITHUB_APP_INSTALLATION_ID")
	}
	if privateKeyPEM == "" {
		missing = append(missing, "GITHUB_APP_PRIVATE_KEY")
	}
	if len(missing) > 0 {
		return "", fmt.Errorf("GitHub App not configured (missing env vars: %s)", strings.Join(missing, ", "))
	}

	jwt, err := signJWT(appID, privateKeyPEM)
	if err != nil {
		return "", fmt.Errorf("sign JWT (app_id=%s): %w", appID, err)
	}

	url := fmt.Sprintf("https://api.github.com/app/installations/%s/access_tokens", resolvedInstallID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("token exchange request (app_id=%s, installation_id=%s): %w", appID, resolvedInstallID, err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))
	if resp.StatusCode != http.StatusCreated {
		hint := ""
		if resp.StatusCode == http.StatusUnauthorized {
			hint = " (hint: verify the private key is correct and the builder server's clock is synchronized; clock drift > 60 s causes JWT rejection)"
		}
		return "", fmt.Errorf("GitHub App token exchange failed (HTTP %d, app_id=%s, installation_id=%s): %s%s",
			resp.StatusCode, appID, resolvedInstallID, strings.TrimSpace(string(body)), hint)
	}

	var result struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("parse token response: %w", err)
	}
	if result.Token == "" {
		return "", fmt.Errorf("GitHub App token response contained no token")
	}
	return result.Token, nil
}

// signJWT creates a short-lived RS256 JWT for authenticating as the GitHub App.
// iat is backdated 60 s to handle clock skew; exp is 9 minutes from now.
func signJWT(appID, privateKeyPEM string) (string, error) {
	key, err := parsePrivateKey(privateKeyPEM)
	if err != nil {
		return "", err
	}

	now := time.Now().Unix()
	header := base64URLEncode([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payload, err := json.Marshal(map[string]any{
		"iss": appID,
		"iat": now - 60,
		"exp": now + 540,
	})
	if err != nil {
		return "", fmt.Errorf("marshal JWT payload: %w", err)
	}

	signingInput := header + "." + base64URLEncode(payload)
	h := sha256.New()
	h.Write([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, h.Sum(nil))
	if err != nil {
		return "", fmt.Errorf("sign JWT: %w", err)
	}

	return signingInput + "." + base64URLEncode(sig), nil
}

func parsePrivateKey(pemStr string) (*rsa.PrivateKey, error) {
	// GitHub private keys may have literal \n instead of real newlines when
	// passed via environment variables.
	pemStr = strings.ReplaceAll(pemStr, `\n`, "\n")

	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("no PEM block found in private key")
	}

	// Try PKCS#1 first (GitHub's default format), then PKCS#8.
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("private key is not RSA")
	}
	return rsaKey, nil
}

func base64URLEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

// readSecretOrEnv reads a secret value from a file if <KEY>_FILE is set,
// falling back to the plain environment variable.
func readSecretOrEnv(key string) string {
	if path := os.Getenv(key + "_FILE"); path != "" {
		if data, err := os.ReadFile(path); err == nil {
			return strings.TrimRight(string(data), "\n")
		}
	}
	return os.Getenv(key)
}
