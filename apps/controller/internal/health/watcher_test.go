package health

import (
	"context"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

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
		store:       fs,
		log:         zap.NewNop(),
		current:     make(map[appKey]liveDeployment),
		podsByApp:   make(map[appKey]map[types.UID]*corev1.Pod),
		tracking:    make(map[types.UID]*restartTracking),
		noPodsSince: make(map[appKey]time.Time),
		lastWritten: make(map[string]string),
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
	w.lastWritten["old-app-id"] = "healthy|"

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
