//go:build lifecycle

package lifecycle

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"

	libk8s "canette.dev/lib/k8s"
)

type project struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
}

// namespace is the project's app namespace for its current slug.
func (p project) namespace() string { return libk8s.AppNamespace(p.ID, p.Slug) }

type app struct {
	ID      string `json:"id"`
	Slug    string `json:"slug"`
	LiveURL string `json:"liveUrl"`
}

type deployment struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	ErrorMessage string `json:"errorMessage"`
	ImageDigest  string `json:"imageDigest"`
}

// Statuses a deployment does not leave on its own.
var terminalStatuses = []string{"live", "failed", "stopped"}

// Build and rollout of the busybox fixture take well under this.
const deployTimeout = 7 * time.Minute

// newProject creates a project whose slug starts with the run's smoke project
// slug, so the e2e cleanup removes its namespaces.
func newProject(t *testing.T, name string) project {
	t.Helper()
	var p project
	api.call(t, http.MethodPost, "/api/v1/projects", map[string]string{
		"teamId": env.TeamID,
		"name":   "Lifecycle " + name,
		"slug":   projectSlug(name),
	}, &p)
	return p
}

func projectSlug(name string) string {
	return fmt.Sprintf("%s-%s-%s", env.ProjectSlugPrefix, name, randHex(2))
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// newApp creates a web app built from the run's Git fixture. It is not deployed.
func newApp(t *testing.T, p project, slug string) app {
	t.Helper()
	var a app
	api.call(t, http.MethodPost, "/api/v1/projects/"+p.ID+"/apps", map[string]any{
		"name":            slug,
		"slug":            slug,
		"sourceType":      "git",
		"deploymentType":  "web",
		"gitUrl":          env.GitURL,
		"gitBranch":       "main",
		"gitCredentialId": env.CredentialID,
		"port":            8080,
	}, &a)
	return a
}

func getApp(t *testing.T, appID string) app {
	t.Helper()
	var a app
	api.call(t, http.MethodGet, "/api/v1/apps/"+appID, nil, &a)
	return a
}

// deploy starts a build and deployment of the app's branch.
func deploy(t *testing.T, a app) deployment {
	t.Helper()
	var d deployment
	api.call(t, http.MethodPost, "/api/v1/apps/"+a.ID+"/deployments", map[string]any{}, &d)
	return d
}

// redeploy starts a deployment of d's image, without a build.
func redeploy(t *testing.T, d deployment) deployment {
	t.Helper()
	var out deployment
	api.call(t, http.MethodPost, "/api/v1/deployments/"+d.ID+"/redeploy", nil, &out)
	return out
}

func deployments(t *testing.T, a app) []deployment {
	t.Helper()
	var out struct {
		Items []deployment `json:"items"`
	}
	api.call(t, http.MethodGet, "/api/v1/apps/"+a.ID+"/deployments", nil, &out)
	return out.Items
}

func getDeployment(t *testing.T, a app, id string) (deployment, bool) {
	t.Helper()
	for _, d := range deployments(t, a) {
		if d.ID == id {
			return d, true
		}
	}
	return deployment{}, false
}

// waitDeployment waits until the deployment reaches a terminal status and
// fails the test unless it is want.
func waitDeployment(t *testing.T, a app, id, want string, timeout time.Duration) deployment {
	t.Helper()
	var d deployment
	eventually(t, timeout, 3*time.Second, fmt.Sprintf("deployment %s to finish", id), func() (bool, error) {
		var ok bool
		d, ok = getDeployment(t, a, id)
		if !ok {
			return false, fmt.Errorf("deployment %s is not in the app's history", id)
		}
		return slices.Contains(terminalStatuses, d.Status), nil
	})
	if d.Status != want {
		t.Fatalf("deployment %s finished %s (%s), want %s", id, d.Status, d.ErrorMessage, want)
	}
	return d
}

// deployLive deploys the app and waits until it is live.
func deployLive(t *testing.T, a app) deployment {
	t.Helper()
	d := deploy(t, a)
	return waitDeployment(t, a, d.ID, "live", deployTimeout)
}

func stopApp(t *testing.T, a app) {
	t.Helper()
	api.call(t, http.MethodPost, "/api/v1/apps/"+a.ID+"/stop", nil, nil)
}

func deleteApp(t *testing.T, a app) {
	t.Helper()
	api.call(t, http.MethodDelete, "/api/v1/apps/"+a.ID, nil, nil)
}

type volume struct {
	ID string `json:"id"`
}

func addPVCVolume(t *testing.T, a app, mountPath, size string) volume {
	t.Helper()
	var v volume
	api.call(t, http.MethodPost, "/api/v1/apps/"+a.ID+"/volumes", map[string]any{
		"type":      "pvc",
		"mountPath": mountPath,
		"config":    map[string]string{"size": size},
	}, &v)
	return v
}
