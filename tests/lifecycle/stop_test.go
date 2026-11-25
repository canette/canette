//go:build lifecycle

package lifecycle

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	libk8s "canette.dev/lib/k8s"
)

// Scenario 1 of #330: Stop, then redeploy at once. The redeploy cancels the
// queued teardown, so the stopped deployment's teardown never changes the
// new workload.
func TestStopThenRedeploy(t *testing.T) {
	p := newProject(t, "stop-redeploy")
	a := newApp(t, p, "web")
	ns := p.namespace()
	live := deployLive(t, a)

	stopApp(t, a)
	next := redeploy(t, live)
	waitDeployment(t, a, next.ID, "live", deployTimeout)
	uid := requireWorkloadOf(t, ns, a.Slug, next.ID, "")

	time.Sleep(3 * pollInterval) // let any teardown or cleanup poll run
	requireWorkloadOf(t, ns, a.Slug, next.ID, uid)
	if d, _ := getDeployment(t, a, live.ID); d.Status != "stopped" {
		t.Errorf("stopped deployment %s is %s, want stopped", live.ID, d.Status)
	}
	requireServing(t, a)
}

// Scenario 1 of #330: Stop while a build or rollout is running, then redeploy
// at once. Stop doesn't end an attempt in progress yet, so the redeploy is
// refused until it finishes, and the stopped deployment's teardown can delete
// the attempt's new workload.
func TestStopDuringBuildThenRedeploy(t *testing.T) {
	blockedBy(t, 331, "whether a build that finishes after Stop still deploys is undecided")
}

func TestStopDuringDeployThenRedeploy(t *testing.T) {
	blockedBy(t, 331, "a teardown that already read the stopped row can delete the rollout's workload")
}

// requireWorkloadOf fails the test unless the app's Deployment runs pods of
// the deployment with ID deploymentID and, when uid is set, is still the
// object with that UID. It returns the Deployment's UID.
func requireWorkloadOf(t *testing.T, ns, appSlug, deploymentID string, uid types.UID) types.UID {
	t.Helper()
	d, err := kube.AppsV1().Deployments(ns).Get(context.Background(), appSlug, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get Deployment %s/%s: %v", ns, appSlug, err)
	}
	if uid != "" && d.UID != uid {
		t.Errorf("Deployment %s/%s was re-created (UID %s, was %s)", ns, appSlug, d.UID, uid)
	}
	if got := d.Spec.Template.Labels[libk8s.LabelDeployment]; got != deploymentID {
		t.Errorf("Deployment %s/%s runs deployment %s, want %s", ns, appSlug, got, deploymentID)
	}
	return d.UID
}
