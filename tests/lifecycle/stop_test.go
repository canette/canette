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

// Scenario 1 of #330: Stop while a rollout is running, then redeploy. Stop is
// durable (#354): the attempt in progress ends stopped instead of going live,
// and its teardown never touches the redeploy's workload.
func TestStopDuringDeployThenRedeploy(t *testing.T) {
	p := newProject(t, "stop-rollout")
	a := newApp(t, p, "web")
	ns := p.namespace()
	live := deployLive(t, a)

	d := redeploy(t, live)
	waitStatus(t, a, d.ID, "deploying", 2*time.Minute)
	stopApp(t, a)
	waitDeployment(t, a, d.ID, "stopped", 2*time.Minute)
	waitWorkloadGone(t, ns, a.Slug, time.Minute)

	next := redeploy(t, live)
	waitDeployment(t, a, next.ID, "live", deployTimeout)
	uid := requireWorkloadOf(t, ns, a.Slug, next.ID, "")
	time.Sleep(3 * pollInterval) // let any teardown or cleanup poll run
	requireWorkloadOf(t, ns, a.Slug, next.ID, uid)
	requireServing(t, a)
}

// Scenario 1 of #330: Stop while a build is running. The build doesn't go
// live when it finishes (#354): it ends superseded and nothing is rolled
// out. Deploying again brings the app up.
func TestStopDuringBuildThenRedeploy(t *testing.T) {
	p := newProject(t, "stop-build")
	a := newApp(t, p, "web")
	ns := p.namespace()

	d := deploy(t, a)
	waitStatus(t, a, d.ID, "building", 2*time.Minute)
	stopApp(t, a)
	superseded := waitDeployment(t, a, d.ID, "superseded", deployTimeout)
	time.Sleep(3 * pollInterval) // let any rollout poll run
	if ok, err := workloadExists(t, ns, a.Slug); ok || err != nil {
		t.Errorf("a workload exists after the stopped build finished (err %v)", err)
	}

	// A build that finished keeps its image and can be redeployed. One the
	// builder skipped before it started has none, and needs a new build.
	var next deployment
	if superseded.ImageDigest != "" {
		next = redeploy(t, superseded)
	} else {
		next = deploy(t, a)
	}
	waitDeployment(t, a, next.ID, "live", deployTimeout)
	requireServing(t, a)
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
