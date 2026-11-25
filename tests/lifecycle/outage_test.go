//go:build lifecycle

package lifecycle

import (
	"context"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	libk8s "canette.dev/lib/k8s"
)

// The controller rewrites an unchanged verdict every healthRewriteInterval
// (5m, apps/controller/internal/health/watcher.go) while Kubernetes answers,
// and the API reports a verdict older than RUNTIME_HEALTH_STALE_AFTER_MS
// (10m, apps/api/src/services/apps.ts) as unknown.
const (
	healthStaleAfter = 10 * time.Minute
	// After a cut, the last confirmation is at most one rewrite interval plus
	// a refresh (30s) old; the verdict goes stale healthStaleAfter after it.
	staleTimeout = healthStaleAfter + time.Minute + pollInterval
	// After a restore, the next refresh (30s) confirms and rewrites it.
	recoverTimeout = 2 * time.Minute
)

// long reports whether LIFECYCLE_LONG=1 asks for the scenarios that wait out
// the 10-minute stale window (about 25 extra minutes).
func long() bool { return os.Getenv("LIFECYCLE_LONG") == "1" }

// Scenario 5 of #330 (see #327): an app that stays healthy longer than the
// stale window still reads healthy. Cutting the controller off from
// Kubernetes makes its health unknown, and restoring access brings it back
// without any Pod change. The REST API and MCP give the same answer (the UI
// renders the REST API's runtimeHealth as is).
//
// Without LIFECYCLE_LONG=1 only the cut and restore are checked, through the
// controller's log, since the verdict can't go stale in that time.
func TestKubernetesOutage(t *testing.T) {
	p := newProject(t, "outage")
	a := newApp(t, p, "web")
	ns := p.namespace()
	deployLive(t, a)
	token := mcpToken(t)
	requireHealth(t, a, token, "healthy", recoverTimeout)
	pods := appPodUIDs(t, ns, a.Slug)
	liveAt := time.Now()

	t.Run("healthy past the stale window", func(t *testing.T) {
		if !long() {
			t.Skip("waits 11 minutes; set LIFECYCLE_LONG=1")
		}
		first := getApp(t, a.ID).RuntimeHealthUpdatedAt
		time.Sleep(time.Until(liveAt.Add(healthStaleAfter + time.Minute)))
		got := requireHealth(t, a, token, "healthy", 0)
		if got.RuntimeHealthUpdatedAt == first {
			t.Errorf("runtimeHealthUpdatedAt still %s after %s: the verdict was not confirmed again", first, healthStaleAfter)
		}
	})

	t.Run("cut off", func(t *testing.T) {
		revokeControllerRBAC(t)
		waitControllerLog(t, time.Minute, "kubernetes unreachable, runtime health will go stale")
		if long() {
			requireHealth(t, a, token, "unknown", staleTimeout)
		} else {
			requireHealth(t, a, token, "healthy", 0)
		}
	})

	t.Run("restored", func(t *testing.T) {
		restoreControllerRBAC(t)
		waitControllerLog(t, time.Minute, "kubernetes reachable again, runtime health refreshing")
		requireHealth(t, a, token, "healthy", recoverTimeout)
		if got := appPodUIDs(t, ns, a.Slug); !slices.Equal(got, pods) {
			t.Errorf("app pods changed during the outage: %v, were %v", got, pods)
		}
	})
}

// requireHealth waits until the REST API and MCP both report want as the
// app's runtime health, and fails the test unless they do within timeout (a
// zero timeout checks once). It returns the REST API's app.
func requireHealth(t *testing.T, a app, token, want string, timeout time.Duration) app {
	t.Helper()
	var rest app
	eventually(t, timeout, pollInterval, "runtime health "+want+" in the REST API and MCP", func() (bool, error) {
		rest = getApp(t, a.ID)
		viaMCP, err := mcpGetApp(token, a.ID)
		if err != nil {
			return false, err
		}
		if rest.RuntimeHealth != want || viaMCP.RuntimeHealth != want {
			return false, fmt.Errorf("REST API %q (%s), MCP %q (%s)",
				rest.RuntimeHealth, rest.RuntimeHealthReason, viaMCP.RuntimeHealth, viaMCP.RuntimeHealthReason)
		}
		return true, nil
	})
	return rest
}

// appPodUIDs returns the UIDs of the app's pods, sorted.
func appPodUIDs(t *testing.T, ns, appSlug string) []types.UID {
	t.Helper()
	list, err := kube.CoreV1().Pods(ns).List(context.Background(),
		metav1.ListOptions{LabelSelector: libk8s.AppLabelSelector(appSlug)})
	if err != nil {
		t.Fatalf("list pods in %s: %v", ns, err)
	}
	uids := make([]types.UID, 0, len(list.Items))
	for _, pod := range list.Items {
		uids = append(uids, pod.UID)
	}
	slices.Sort(uids)
	return uids
}

// controllerBinding is the chart's ClusterRoleBinding for the controller
// (charts/canette/templates/controller/clusterrolebinding.yaml).
const controllerBinding = "canette-controller"

// revokeControllerRBAC empties the controller's ClusterRoleBinding, so every
// Kubernetes call it makes is forbidden. It is restored when the test ends,
// if restoreControllerRBAC hasn't run.
func revokeControllerRBAC(t *testing.T) {
	t.Helper()
	crb, err := kube.RbacV1().ClusterRoleBindings().Get(context.Background(), controllerBinding, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get ClusterRoleBinding %s: %v", controllerBinding, err)
	}
	if !slices.ContainsFunc(crb.Subjects, func(s rbacv1.Subject) bool {
		return s.Kind == rbacv1.ServiceAccountKind && s.Namespace == env.ReleaseNamespace
	}) {
		t.Fatalf("ClusterRoleBinding %s doesn't bind a service account in %s: %+v", controllerBinding, env.ReleaseNamespace, crb.Subjects)
	}
	revokedSubjects = crb.Subjects
	crb.Subjects = nil
	if _, err := kube.RbacV1().ClusterRoleBindings().Update(context.Background(), crb, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("revoke ClusterRoleBinding %s: %v", controllerBinding, err)
	}
	t.Cleanup(func() { restoreControllerRBAC(t) })
}

// revokedSubjects are the subjects revokeControllerRBAC removed, until
// restoreControllerRBAC puts them back.
var revokedSubjects []rbacv1.Subject

func restoreControllerRBAC(t *testing.T) {
	t.Helper()
	if revokedSubjects == nil {
		return
	}
	crb, err := kube.RbacV1().ClusterRoleBindings().Get(context.Background(), controllerBinding, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get ClusterRoleBinding %s: %v", controllerBinding, err)
	}
	crb.Subjects = revokedSubjects
	if _, err := kube.RbacV1().ClusterRoleBindings().Update(context.Background(), crb, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("restore ClusterRoleBinding %s: %v", controllerBinding, err)
	}
	revokedSubjects = nil
}
