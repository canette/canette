//go:build lifecycle

package lifecycle

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// mcpRedirectURI is registered for the test's OAuth client. Nothing listens
// on it: the authorization code is read from the redirect's Location header.
const mcpRedirectURI = "http://127.0.0.1:1/callback"

// mcpToken gets an MCP access token for the signed-in user the way an MCP
// client does: dynamic registration, then the consent action's POST
// /oauth/confirm with PKCE, then the code exchange.
func mcpToken(t *testing.T) string {
	t.Helper()
	var client struct {
		ClientID string `json:"client_id"`
	}
	api.call(t, http.MethodPost, "/oauth/register", map[string]any{
		"client_name":   "canette lifecycle tests",
		"redirect_uris": []string{mcpRedirectURI},
	}, &client)

	verifier := base64.RawURLEncoding.EncodeToString([]byte(randHex(32)))
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"client_id":             {client.ClientID},
		"response_type":         {"code"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"},
		"redirect_uri":          {mcpRedirectURI},
		"state":                 {"lifecycle"},
	}
	req, err := http.NewRequest(http.MethodPost, api.base+"/oauth/confirm?"+q.Encode(), http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", api.base)
	noRedirect := *api.http
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := noRedirect.Do(req)
	if err != nil {
		t.Fatalf("POST /oauth/confirm: %v", err)
	}
	_ = resp.Body.Close()
	loc, err := resp.Location()
	if err != nil {
		t.Fatalf("POST /oauth/confirm: HTTP %d without a redirect: %v", resp.StatusCode, err)
	}
	code := loc.Query().Get("code")
	if code == "" {
		t.Fatalf("POST /oauth/confirm redirected to %s, without a code", loc)
	}

	var token struct {
		AccessToken string `json:"access_token"`
	}
	api.call(t, http.MethodPost, "/oauth/token", map[string]string{
		"grant_type":    "authorization_code",
		"code":          code,
		"code_verifier": verifier,
		"redirect_uri":  mcpRedirectURI,
	}, &token)
	return token.AccessToken
}

// mcpGetApp calls the MCP get_app tool and returns the app it reports.
func mcpGetApp(token, appID string) (app, error) {
	var a app
	text, err := mcpCallTool(token, "get_app", map[string]any{"app_id": appID})
	if err != nil {
		return a, err
	}
	if err := json.Unmarshal([]byte(text), &a); err != nil {
		return a, fmt.Errorf("decode get_app result %s: %w", text, err)
	}
	return a, nil
}

// mcpCallTool sends one tools/call to the stateless MCP endpoint and returns
// the text of the result's first content block.
func mcpCallTool(token, name string, args map[string]any) (string, error) {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": name, "arguments": args},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, api.base+"/mcp", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := api.http.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("MCP %s: HTTP %d: %s", name, resp.StatusCode, data)
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		if data, err = sseData(data); err != nil {
			return "", fmt.Errorf("MCP %s: %w", name, err)
		}
	}

	var out struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", fmt.Errorf("MCP %s: decode %s: %w", name, data, err)
	}
	switch {
	case out.Error != nil:
		return "", fmt.Errorf("MCP %s: %s", name, out.Error.Message)
	case len(out.Result.Content) == 0:
		return "", fmt.Errorf("MCP %s: empty result: %s", name, data)
	case out.Result.IsError:
		return "", fmt.Errorf("MCP %s: %s", name, out.Result.Content[0].Text)
	}
	return out.Result.Content[0].Text, nil
}

// sseData returns the data of the first event in a text/event-stream body.
func sseData(body []byte) ([]byte, error) {
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for sc.Scan() {
		if data, ok := strings.CutPrefix(sc.Text(), "data:"); ok {
			return []byte(strings.TrimSpace(data)), nil
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("no data in the event stream")
}
