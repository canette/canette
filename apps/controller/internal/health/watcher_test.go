package health

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"

	"canette.dev/controller/internal/store"
	libk8s "canette.dev/lib/k8s"
)

// These tests exercise the Watcher's event-handling and evaluation logic
// directly (onPodChanged/onPodDeleted/refreshCurrentDeployments) rather than
// running the full informer via Run() — the informer wiring itself is thin
// glue code; the real risk (stale-pod filtering, debouncing, cronjob
// skipping) lives in these methods, and testing them directly avoids
// depending on informer cache-sync timing.

type healthUpdate struct{ appID, health, reason string }

type fakeHealthStore struct {
	current []store.CurrentDeployment
	updates []healthUpdate
}

func (f *fakeHealthStore) GetCurrentDeployments(_ context.Context) ([]store.CurrentDeployment, error) {
	return f.current, nil
}

func (f *fakeHealthStore) UpdateRuntimeHealth(_ context.Context, appID, health, reason string) error {
	f.updates = append(f.updates, healthUpdate{appID, health, reason})
	return nil
}

func newTestWatcher(fs *fakeHealthStore) *Watcher {
	return &Watcher{
		client:      fake.NewSimpleClientset(),
		store:       fs,
		log:         zap.NewNop(),
		current:     make(map[appKey]liveDeployment),
		podsByApp:   make(map[appKey]map[types.UID]*corev1.Pod),
		tracking:    make(map[types.UID]*restartTracking),
		noPodsSince: make(map[appKey]time.Time),
		lastWritten: make(map[string]writtenVerdict),
	}
}

func testPod(uid types.UID, name, projectID, appSlug, deploymentID string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			UID:  uid,
			Name: name,
			Labels: map[string]string{
				libk8s.LabelProjectID:  projectID,
				libk8s.LabelApp:        appSlug,
				libk8s.LabelDeployment: deploymentID,
			},
		},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}},
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
		},
	}
}

func TestWatcher_HealthyPodForCurrentDeployment(t *testing.T) {
	fs := &fakeHealthStore{}
	w := newTestWatcher(fs)
	key := appKey{projectID: "proj-1", appSlug: "app-1"}
	w.current[key] = liveDeployment{appID: "app-id-1", deploymentID: "dep-new", deploymentType: "web"}

	pod := testPod("pod-1", "app-1-abc", "proj-1", "app-1", "dep-new")
	w.onPodChanged(context.Background(), pod)

	if len(fs.updates) != 1 {
		t.Fatalf("expected exactly 1 update, got %d: %+v", len(fs.updates), fs.updates)
	}
	if fs.updates[0].health != HealthHealthy {
		t.Errorf("expected healthy, got %+v", fs.updates[0])
	}
}

// The exact stale-pod bug from issue #197: a crashing pod belonging to a
// SUPERSEDED deployment must never make the current deployment look
// unhealthy.
func TestWatcher_StalePodIgnored(t *testing.T) {
	fs := &fakeHealthStore{}
	w := newTestWatcher(fs)
	key := appKey{projectID: "proj-1", appSlug: "app-1"}
	w.current[key] = liveDeployment{appID: "app-id-1", deploymentID: "dep-new", deploymentType: "web"}

	stale := testPod("pod-old", "app-1-old", "proj-1", "app-1", "dep-old")
	stale.Status.ContainerStatuses = []corev1.ContainerStatus{
		{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}},
	}
	w.onPodChanged(context.Background(), stale)

	if len(fs.updates) != 1 {
		t.Fatalf("expected exactly 1 update, got %d: %+v", len(fs.updates), fs.updates)
	}
	if fs.updates[0].health == HealthUnhealthy {
		t.Errorf("stale pod from a superseded deployment must not report the current deployment unhealthy, got %+v", fs.updates[0])
	}
}

func TestWatcher_CrashingPodForCurrentDeployment(t *testing.T) {
	fs := &fakeHealthStore{}
	w := newTestWatcher(fs)
	key := appKey{projectID: "proj-1", appSlug: "app-1"}
	w.current[key] = liveDeployment{appID: "app-id-1", deploymentID: "dep-new", deploymentType: "web"}

	pod := testPod("pod-1", "app-1-abc", "proj-1", "app-1", "dep-new")
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{
		{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137}}},
	}
	w.onPodChanged(context.Background(), pod)

	if len(fs.updates) != 1 {
		t.Fatalf("expected exactly 1 update, got %d: %+v", len(fs.updates), fs.updates)
	}
	if fs.updates[0].health != HealthUnhealthy || !strings.Contains(fs.updates[0].reason, "OOMKilled") {
		t.Errorf("expected unhealthy with OOMKilled reason, got %+v", fs.updates[0])
	}
}

func TestWatcher_CronJobSkipped(t *testing.T) {
	fs := &fakeHealthStore{}
	w := newTestWatcher(fs)
	key := appKey{projectID: "proj-1", appSlug: "job-1"}
	w.current[key] = liveDeployment{appID: "app-id-1", deploymentID: "dep-new", deploymentType: "cronjob"}

	pod := testPod("pod-1", "job-1-abc", "proj-1", "job-1", "dep-new")
	w.onPodChanged(context.Background(), pod)

	if len(fs.updates) != 0 {
		t.Errorf("expected no runtime-health writes for a cronjob, got %+v", fs.updates)
	}
}

func TestWatcher_DebouncesUnchangedVerdict(t *testing.T) {
	fs := &fakeHealthStore{}
	w := newTestWatcher(fs)
	key := appKey{projectID: "proj-1", appSlug: "app-1"}
	w.current[key] = liveDeployment{appID: "app-id-1", deploymentID: "dep-new", deploymentType: "web"}

	pod := testPod("pod-1", "app-1-abc", "proj-1", "app-1", "dep-new")
	w.onPodChanged(context.Background(), pod)
	w.onPodChanged(context.Background(), pod) // same pod, same state — must not write again

	if len(fs.updates) != 1 {
		t.Errorf("expected the unchanged verdict to be debounced (1 write total), got %d: %+v", len(fs.updates), fs.updates)
	}
}

func TestWatcher_OnPodDeletedRemovesTrackingState(t *testing.T) {
	fs := &fakeHealthStore{}
	w := newTestWatcher(fs)
	key := appKey{projectID: "proj-1", appSlug: "app-1"}
	w.current[key] = liveDeployment{appID: "app-id-1", deploymentID: "dep-new", deploymentType: "web"}

	pod := testPod("pod-1", "app-1-abc", "proj-1", "app-1", "dep-new")
	w.onPodChanged(context.Background(), pod)
	w.onPodDeleted(context.Background(), pod)

	if len(w.podsByApp[key]) != 0 {
		t.Errorf("expected pod to be removed from podsByApp after deletion, got %+v", w.podsByApp[key])
	}
	if _, tracked := w.tracking[pod.UID]; tracked {
		t.Error("expected restart tracking to be removed after pod deletion")
	}
}

func TestWatcher_RefreshCurrentDeploymentsCleansUpStaleApps(t *testing.T) {
	fs := &fakeHealthStore{}
	w := newTestWatcher(fs)
	staleKey := appKey{projectID: "proj-1", appSlug: "old-app"}
	w.current[staleKey] = liveDeployment{appID: "old-app-id", deploymentID: "dep-1", deploymentType: "web"}
	w.podsByApp[staleKey] = map[types.UID]*corev1.Pod{"pod-1": testPod("pod-1", "old-app-x", "proj-1", "old-app", "dep-1")}
	w.noPodsSince[staleKey] = time.Now()
	w.lastWritten["old-app-id"] = writtenVerdict{verdict: "healthy|", at: time.Now()}

	// The app no longer appears in the DB's current-deployments list (e.g. stopped).
	fs.current = nil
	if err := w.refreshCurrentDeployments(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, ok := w.current[staleKey]; ok {
		t.Error("expected stale app to be removed from current map")
	}
	if _, ok := w.podsByApp[staleKey]; ok {
		t.Error("expected stale app's cached pods to be cleaned up")
	}
	if _, ok := w.lastWritten["old-app-id"]; ok {
		t.Error("expected stale app's lastWritten debounce entry to be cleaned up")
	}
}

// liveHealthyApp sets up one live app whose pod is healthy and whose verdict
// was last written writtenAgo ago.
func liveHealthyApp(t *testing.T, writtenAgo time.Duration) (*Watcher, *fakeHealthStore) {
	t.Helper()
	fs := &fakeHealthStore{current: []store.CurrentDeployment{
		{AppID: "app-id-1", AppSlug: "app-1", ProjectID: "proj-1", DeploymentID: "dep-new", DeploymentType: "web"},
	}}
	w := newTestWatcher(fs)
	if err := w.refreshCurrentDeployments(context.Background()); err != nil {
		t.Fatal(err)
	}
	w.onPodChanged(context.Background(), testPod("pod-1", "app-1-abc", "proj-1", "app-1", "dep-new"))
	if len(fs.updates) == 0 || fs.updates[len(fs.updates)-1].health != "healthy" {
		t.Fatalf("expected a healthy verdict to be written, got %+v", fs.updates)
	}
	last := w.lastWritten["app-id-1"]
	last.at = time.Now().Add(-writtenAgo)
	w.lastWritten["app-id-1"] = last
	fs.updates = nil
	return w, fs
}

func TestWatcher_RewritesUnchangedVerdictWhenDue(t *testing.T) {
	w, fs := liveHealthyApp(t, healthRewriteInterval+time.Second)
	if err := w.refreshCurrentDeployments(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fs.updates) != 1 || fs.updates[0].health != "healthy" {
		t.Fatalf("expected the unchanged verdict to be rewritten once, got %+v", fs.updates)
	}
	// Just written: the next refresh leaves it alone.
	if err := w.refreshCurrentDeployments(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fs.updates) != 1 {
		t.Errorf("expected no second rewrite, got %+v", fs.updates)
	}
}

func TestWatcher_DoesNotRewriteBeforeInterval(t *testing.T) {
	w, fs := liveHealthyApp(t, healthRewriteInterval-time.Minute)
	if err := w.refreshCurrentDeployments(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fs.updates) != 0 {
		t.Errorf("expected no rewrite before the interval, got %+v", fs.updates)
	}
}

func TestWatcher_DoesNotRewriteWhenKubernetesUnreachable(t *testing.T) {
	w, fs := liveHealthyApp(t, healthRewriteInterval+time.Second)
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "pods", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("connection refused")
	})
	w.client = client

	if err := w.refreshCurrentDeployments(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fs.updates) != 0 {
		t.Fatalf("expected no rewrite while Kubernetes is unreachable, got %+v", fs.updates)
	}

	// Reachable again: the overdue verdict is rewritten without any pod change.
	w.client = fake.NewSimpleClientset()
	if err := w.refreshCurrentDeployments(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fs.updates) != 1 || fs.updates[0].health != "healthy" {
		t.Errorf("expected the verdict to be rewritten once reachable, got %+v", fs.updates)
	}
}

func TestWatcher_PodEventsDoNotRewriteUnchangedVerdict(t *testing.T) {
	w, fs := liveHealthyApp(t, healthRewriteInterval+time.Second)
	w.onPodChanged(context.Background(), testPod("pod-1", "app-1-abc", "proj-1", "app-1", "dep-new"))
	if len(fs.updates) != 0 {
		t.Errorf("expected a pod event with an unchanged verdict not to write, got %+v", fs.updates)
	}
}
