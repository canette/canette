package health

import (
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
)

func podWithContainerState(state corev1.ContainerState) *corev1.Pod {
	return &corev1.Pod{
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{{Name: "app", State: state}},
		},
	}
}

func TestEvaluatePod_WaitingBackoffReasons(t *testing.T) {
	now := time.Now()
	for _, reason := range []string{"CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"} {
		pod := podWithContainerState(corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}})
		eval := evaluatePod(pod, &restartTracking{}, now)
		if eval.Healthy {
			t.Errorf("reason %q: expected unhealthy", reason)
		}
		if eval.Reason != reason {
			t.Errorf("reason %q: expected verdict reason %q, got %q", reason, reason, eval.Reason)
		}
	}
}

// A pod's FIRST crash surfaces as Terminated, not Waiting — kubelet only
// starts backing off (CrashLoopBackOff) after several restarts. This is what
// makes the first crash from issue #197 visible.
func TestEvaluatePod_TerminatedFirstCrash(t *testing.T) {
	now := time.Now()
	pod := podWithContainerState(corev1.ContainerState{
		Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137},
	})
	eval := evaluatePod(pod, &restartTracking{}, now)
	if eval.Healthy {
		t.Fatal("expected a Terminated container with nonzero exit code to be unhealthy")
	}
	if !strings.Contains(eval.Reason, "OOMKilled") || !strings.Contains(eval.Reason, "137") {
		t.Errorf("expected reason to mention OOMKilled and exit code, got %q", eval.Reason)
	}
}

func TestEvaluatePod_SingleRestartIsNotFlagged(t *testing.T) {
	now := time.Now()
	pod := podWithContainerState(corev1.ContainerState{Running: &corev1.ContainerStateRunning{}})
	tr := &restartTracking{restarts: []time.Time{now.Add(-1 * time.Minute)}}
	eval := evaluatePod(pod, tr, now)
	if !eval.Healthy {
		t.Errorf("expected a single isolated restart (normal self-healing) not to be flagged, got reason %q", eval.Reason)
	}
}

func TestEvaluatePod_SustainedRestartsAreFlagged(t *testing.T) {
	now := time.Now()
	pod := podWithContainerState(corev1.ContainerState{Running: &corev1.ContainerStateRunning{}})
	tr := &restartTracking{restarts: []time.Time{
		now.Add(-4 * time.Minute),
		now.Add(-2 * time.Minute),
		now.Add(-1 * time.Minute),
	}}
	eval := evaluatePod(pod, tr, now)
	if eval.Healthy {
		t.Fatal("expected 3 restarts within the tracking window to be flagged")
	}
	if eval.Reason != "restarting repeatedly" {
		t.Errorf("expected reason 'restarting repeatedly', got %q", eval.Reason)
	}
}

func TestEvaluatePod_NotReadyWithinGraceIsHealthy(t *testing.T) {
	now := time.Now()
	pod := podWithContainerState(corev1.ContainerState{Running: &corev1.ContainerStateRunning{}})
	tr := &restartTracking{notReadySince: now.Add(-10 * time.Second)}
	eval := evaluatePod(pod, tr, now)
	if !eval.Healthy {
		t.Errorf("expected not-ready within the grace period to still be healthy, got reason %q", eval.Reason)
	}
}

func TestEvaluatePod_NotReadyPastGraceIsUnhealthy(t *testing.T) {
	now := time.Now()
	pod := podWithContainerState(corev1.ContainerState{Running: &corev1.ContainerStateRunning{}})
	tr := &restartTracking{notReadySince: now.Add(-90 * time.Second)}
	eval := evaluatePod(pod, tr, now)
	if eval.Healthy {
		t.Fatal("expected not-ready past the grace period to be unhealthy")
	}
	if eval.Reason != "readiness probe failing" {
		t.Errorf("expected reason 'readiness probe failing', got %q", eval.Reason)
	}
}

func TestEvaluatePod_HealthyRunningPod(t *testing.T) {
	now := time.Now()
	pod := podWithContainerState(corev1.ContainerState{Running: &corev1.ContainerStateRunning{}})
	eval := evaluatePod(pod, &restartTracking{}, now)
	if !eval.Healthy {
		t.Errorf("expected a plain running pod to be healthy, got reason %q", eval.Reason)
	}
}

func TestRestartTracking_Observe_TracksIncreasesAndPrunesOldEntries(t *testing.T) {
	now := time.Now()
	tr := &restartTracking{}
	pod := &corev1.Pod{Status: corev1.PodStatus{
		ContainerStatuses: []corev1.ContainerStatus{{RestartCount: 1}},
		Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
	}}
	tr.observe(pod, now.Add(-10*time.Minute)) // old restart, should get pruned
	pod.Status.ContainerStatuses[0].RestartCount = 2
	tr.observe(pod, now) // recent restart, should be kept

	if len(tr.restarts) != 1 {
		t.Fatalf("expected exactly 1 restart timestamp after pruning, got %d", len(tr.restarts))
	}
}

func TestAggregateAppHealth_NoPodsWithinGraceIsUnknown(t *testing.T) {
	now := time.Now()
	health, _ := aggregateAppHealth(nil, now.Add(-5*time.Second), now)
	if health != HealthUnknown {
		t.Errorf("expected unknown while within the no-pods grace period, got %q", health)
	}
}

func TestAggregateAppHealth_NoPodsPastGraceIsUnhealthy(t *testing.T) {
	now := time.Now()
	health, reason := aggregateAppHealth(nil, now.Add(-40*time.Second), now)
	if health != HealthUnhealthy {
		t.Errorf("expected unhealthy once the no-pods grace period elapses, got %q", health)
	}
	if reason != "no running pods" {
		t.Errorf("expected reason 'no running pods', got %q", reason)
	}
}

func TestAggregateAppHealth_AnyUnhealthyPodMakesAppUnhealthy(t *testing.T) {
	now := time.Now()
	evals := []podEvaluation{{Healthy: true}, {Healthy: false, Reason: "OOMKilled (exit 137)"}}
	health, reason := aggregateAppHealth(evals, time.Time{}, now)
	if health != HealthUnhealthy || reason != "OOMKilled (exit 137)" {
		t.Errorf("expected unhealthy with the failing pod's reason, got health=%q reason=%q", health, reason)
	}
}

func TestAggregateAppHealth_AllHealthy(t *testing.T) {
	now := time.Now()
	evals := []podEvaluation{{Healthy: true}, {Healthy: true}}
	health, _ := aggregateAppHealth(evals, time.Time{}, now)
	if health != HealthHealthy {
		t.Errorf("expected healthy, got %q", health)
	}
}
