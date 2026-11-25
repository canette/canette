//go:build lifecycle

package lifecycle

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// runEnv is the release the e2e harness installed (run_lifecycle_tests in
// scripts/e2e/smoke.sh writes it as JSON and passes its path in LIFECYCLE_ENV).
type runEnv struct {
	Kubeconfig        string `json:"kubeconfig"`
	Release           string `json:"release"`
	ReleaseNamespace  string `json:"releaseNamespace"`
	ChartDir          string `json:"chartDir"`
	Domain            string `json:"domain"`
	UIHost            string `json:"uiHost"`
	NodeIP            string `json:"nodeIP"`
	CAFile            string `json:"caFile"`
	Email             string `json:"email"`
	Password          string `json:"password"`
	TeamID            string `json:"teamID"`
	CredentialID      string `json:"credentialID"`
	GitURL            string `json:"gitURL"`
	ProjectSlugPrefix string `json:"projectSlugPrefix"`
}

var (
	env  runEnv
	api  *apiClient
	kube kubernetes.Interface
)

func TestMain(m *testing.M) {
	if err := setup(); err != nil {
		fmt.Fprintf(os.Stderr, "lifecycle setup: %v\n", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func setup() error {
	path := os.Getenv("LIFECYCLE_ENV")
	if path == "" {
		return fmt.Errorf("LIFECYCLE_ENV is not set; run the tests with scripts/e2e/macos-lima.sh --lifecycle")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}

	restCfg, err := clientcmd.BuildConfigFromFlags("", env.Kubeconfig)
	if err != nil {
		return fmt.Errorf("load kubeconfig: %w", err)
	}
	if kube, err = kubernetes.NewForConfig(restCfg); err != nil {
		return err
	}

	if api, err = newAPIClient(); err != nil {
		return err
	}
	return api.signIn()
}

// apiClient calls the Canette API through the UI's HTTPS route, like the
// dashboard does, with a session cookie.
type apiClient struct {
	base string
	http *http.Client
}

func newAPIClient() (*apiClient, error) {
	pem, err := os.ReadFile(env.CAFile)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("no certificates in %s", env.CAFile)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		Proxy:           nil,
		TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		// The test hostnames have no DNS: every *.domain name goes to the node,
		// like curl --resolve in smoke.sh.
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err == nil && (host == env.Domain || strings.HasSuffix(host, "."+env.Domain)) {
				addr = net.JoinHostPort(env.NodeIP, port)
			}
			return dialer.DialContext(ctx, network, addr)
		},
	}
	return &apiClient{
		base: "https://" + env.UIHost,
		http: &http.Client{Transport: transport, Jar: jar, Timeout: 25 * time.Second},
	}, nil
}

func (c *apiClient) signIn() error {
	status, body, err := c.raw(http.MethodPost, "/api/auth/sign-in/email",
		map[string]string{"email": env.Email, "password": env.Password})
	if err != nil {
		return err
	}
	if status/100 != 2 {
		return fmt.Errorf("sign in: HTTP %d: %s", status, body)
	}
	return nil
}

// raw sends a JSON request and returns the status and body, whatever the status.
func (c *apiClient) raw(method, path string, in any) (int, []byte, error) {
	var reqBody io.Reader = http.NoBody
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return 0, nil, err
		}
		reqBody = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.base+path, reqBody)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Origin", c.base)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	return resp.StatusCode, data, err
}

// call sends a JSON request, fails the test unless it returns 2xx, and decodes
// the response into out (when out is not nil).
func (c *apiClient) call(t *testing.T, method, path string, in, out any) {
	t.Helper()
	status, body, err := c.raw(method, path, in)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if status/100 != 2 {
		t.Fatalf("%s %s: HTTP %d: %s", method, path, status, body)
	}
	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			t.Fatalf("%s %s: decode %s: %v", method, path, body, err)
		}
	}
}

// eventually polls cond every interval until it returns true, and fails the
// test with what after timeout. An error from cond is logged and polled again.
func eventually(t *testing.T, timeout, interval time.Duration, what string, cond func() (bool, error)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		ok, err := cond()
		if err != nil {
			lastErr = err
		} else if ok {
			return
		}
		if time.Now().After(deadline) {
			if lastErr != nil {
				t.Fatalf("timed out after %s waiting for %s (last error: %v)", timeout, what, lastErr)
			}
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(interval)
	}
}
