//go:build lifecycle

package lifecycle

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The error_message RecoverAbandonedDeploying sets
// (store.AbandonedDeployingMessage in apps/controller/internal/store).
const abandonedMessage = "controller stopped during this deployment; redeploy to retry"

// A claimed deployment without a heartbeat is failed after
// store.DeployingHeartbeatTTL (2m); an app cleanup claim is retried after
// volumeDeletionClaimTTL (5m). The margins cover polls and the restart.
const (
	abandonTimeout      = 4 * time.Minute
	cleanupRetryTimeout = 7 * time.Minute
)

// Scenario 2 of #330: kill the controller after a claim, after a partial
// apply, and after a delete was accepted. After the restart everything
// settles, the deployment history is kept and pending cleanup is reported.
// The subtests share one app and run in order; the last one deletes it.
func TestControllerCrash(t *testing.T) {
	p := newProject(t, "crash")
	a := newApp(t, p, "web")
	ns := p.namespace()
	history := []string{deployLive(t, a).ID}

	t.Run("after-claim", func(t *testing.T) {
		armFailpoint(t, "after-claim")
		d := redeploy(t, latest(t, a))
		history = append(history, d.ID)
		waitFailpointFired(t, "after-claim", 2*time.Minute)

		failed := waitDeployment(t, a, d.ID, "failed", abandonTimeout)
		if failed.ErrorMessage != abandonedMessage {
			t.Errorf("error message = %q, want %q", failed.ErrorMessage, abandonedMessage)
		}
		requireHistory(t, a, history)

		next := redeploy(t, failed)
		history = append(history, next.ID)
		waitDeployment(t, a, next.ID, "live", deployTimeout)
		requireServing(t, a)
	})

	t.Run("after-partial-apply", func(t *testing.T) {
		armFailpoint(t, "after-partial-apply")
		d := redeploy(t, latest(t, a))
		history = append(history, d.ID)
		waitFailpointFired(t, "after-partial-apply", 2*time.Minute)

		failed := waitDeployment(t, a, d.ID, "failed", abandonTimeout)
		if failed.ErrorMessage != abandonedMessage {
			t.Errorf("error message = %q, want %q", failed.ErrorMessage, abandonedMessage)
		}
		requireHistory(t, a, history)

		next := redeploy(t, failed)
		history = append(history, next.ID)
		waitDeployment(t, a, next.ID, "live", deployTimeout)
		if ok, err := serviceExists(t, ns, a.Slug); !ok {
			t.Errorf("Service %s/%s missing after the redeploy (err %v)", ns, a.Slug, err)
		}
		requireServing(t, a)
	})

	t.Run("after-teardown-delete", func(t *testing.T) {
		armFailpoint(t, "after-teardown-delete")
		stopApp(t, a)
		waitFailpointFired(t, "after-teardown-delete", 2*time.Minute)

		// The crash came before the teardown was recorded, so the restarted
		// controller claims it again and finishes it.
		waitControllerLog(t, time.Minute, "teardown complete", `"project":"`+p.Slug+`"`)
		waitWorkloadGone(t, ns, a.Slug, 10*time.Second)
		if got := getApp(t, a.ID).LiveURL; got != "" {
			t.Errorf("live URL = %q after stop, want none", got)
		}
		requireHistory(t, a, history)

		next := redeploy(t, latest(t, a))
		history = append(history, next.ID)
		waitDeployment(t, a, next.ID, "live", deployTimeout)
	})

	t.Run("after-app-delete", func(t *testing.T) {
		armFailpoint(t, "after-app-delete")
		// Only an app without a running deployment can be deleted.
		stopApp(t, a)
		waitWorkloadGone(t, ns, a.Slug, 2*time.Minute)
		deleteApp(t, a)
		waitFailpointFired(t, "after-app-delete", 2*time.Minute)

		// The cleanup was not recorded, so it is still pending: the slug
		// stays taken until the claim expires and the retry succeeds.
		requireSlugPending(t, p, a.Slug)
		waitControllerLog(t, cleanupRetryTimeout, "deleted app resources", `"namespace":"`+ns+`"`)
		if left := appObjectsLeft(t, ns, a.Slug); len(left) > 0 {
			t.Errorf("objects of deleted app %s left in %s: %v", a.Slug, ns, left)
		}
		newApp(t, p, a.Slug) // the slug is free again
	})
}

// latest returns the app's most recent deployment.
func latest(t *testing.T, a app) deployment {
	t.Helper()
	ds := deployments(t, a)
	if len(ds) == 0 {
		t.Fatalf("app %s has no deployments", a.Slug)
	}
	return ds[0]
}

// requireHistory fails the test unless every deployment in ids is still in
// the app's history.
func requireHistory(t *testing.T, a app, ids []string) {
	t.Helper()
	have := map[string]bool{}
	for _, d := range deployments(t, a) {
		have[d.ID] = true
	}
	for _, id := range ids {
		if !have[id] {
			t.Errorf("deployment %s is missing from the app's history", id)
		}
	}
}

// requireServing fails the test unless the app's live URL answers with the
// fixture page.
func requireServing(t *testing.T, a app) {
	t.Helper()
	url := ""
	eventually(t, time.Minute, 3*time.Second, "the app to report its live URL", func() (bool, error) {
		url = getApp(t, a.ID).LiveURL
		return url != "", nil
	})
	eventually(t, 2*time.Minute, 3*time.Second, "the app to answer at "+url, func() (bool, error) {
		resp, err := api.http.Get(url)
		if err != nil {
			return false, err
		}
		defer func() { _ = resp.Body.Close() }()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return false, err
		}
		if resp.StatusCode != http.StatusOK {
			return false, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		return strings.HasPrefix(string(body), "canette-e2e-"), nil
	})
}

// requireSlugPending fails the test unless creating an app with the slug is
// refused because a deleted app's cleanup is still pending.
func requireSlugPending(t *testing.T, p project, slug string) {
	t.Helper()
	status, body, err := api.raw(http.MethodPost, "/api/v1/projects/"+p.ID+"/apps", map[string]any{
		"name": slug, "slug": slug, "sourceType": "git", "deploymentType": "web",
		"gitUrl": env.GitURL, "gitBranch": "main", "gitCredentialId": env.CredentialID, "port": 8080,
	})
	if err != nil {
		t.Fatal(err)
	}
	var e struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body, &e)
	if status != http.StatusConflict || !strings.Contains(e.Error, "still being cleaned up") {
		t.Errorf("creating app %s during its cleanup: HTTP %d %s, want 409 still being cleaned up", slug, status, body)
	}
}
