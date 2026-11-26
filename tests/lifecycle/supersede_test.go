//go:build lifecycle

package lifecycle

import (
	"testing"
	"time"
)

// A deploy while a build runs replaces it (#354): the running build is
// cancelled and ends superseded, and the newer deploy goes live.
func TestDeployDuringBuild(t *testing.T) {
	p := newProject(t, "deploy-build")
	a := newApp(t, p, "web")
	ns := p.namespace()

	first := deploy(t, a)
	waitStatus(t, a, first.ID, "building", 2*time.Minute)
	second := deploy(t, a)

	waitDeployment(t, a, first.ID, "superseded", deployTimeout)
	waitDeployment(t, a, second.ID, "live", deployTimeout)
	requireWorkloadOf(t, ns, a.Slug, second.ID, "")
	requireServing(t, a)
	if got := getApp(t, a.ID).LifecycleStatus; got != "live" {
		t.Errorf("app status %q, want live", got)
	}
}

// A deploy while a rollout runs: the rollout still finishes, since it is what
// serves until the newer build is ready, and the newer deploy then replaces
// it.
func TestDeployDuringRollout(t *testing.T) {
	p := newProject(t, "deploy-rollout")
	a := newApp(t, p, "web")
	ns := p.namespace()
	live := deployLive(t, a)

	rolling := redeploy(t, live)
	waitStatus(t, a, rolling.ID, "deploying", 2*time.Minute)
	next := deploy(t, a) // a new build

	waitDeployment(t, a, next.ID, "live", deployTimeout)
	if d, _ := getDeployment(t, a, rolling.ID); d.Status != "superseded" {
		t.Errorf("the earlier rollout is %s, want superseded once the newer one is live", d.Status)
	}
	requireWorkloadOf(t, ns, a.Slug, next.ID, "")
	requireServing(t, a)
}
