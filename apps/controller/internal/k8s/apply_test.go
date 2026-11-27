package k8s

import (
	"context"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	libk8s "canette.dev/lib/k8s"
)

// Tests exercise CheckRollout/checkPodsForFailure against a fake clientset
// rather than a real API server — the logic under test is client-go
// List/Get usage plus in-process status derivation, so a fake clientset
// exercises the same code paths without requiring a downloaded
// kube-apiserver/etcd binary.

const testNamespace = "can-test-ns"
const testApp = "my-app"

func availableDeployment(name string, replicas int32) *appsv1.Deployment {
	r := replicas
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace, Generation: 1},
		Spec:       appsv1.DeploymentSpec{Replicas: &r},
		Status: appsv1.DeploymentStatus{
			ObservedGeneration: 1,
			Replicas:           r,
			UpdatedReplicas:    r,
			AvailableReplicas:  r,
		},
	}
}

func podWithLabels(name, deploymentID string, phase corev1.PodPhase) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: testNamespace,
			Labels: map[string]string{
				libk8s.LabelApp:        testApp,
				libk8s.LabelDeployment: deploymentID,
			},
		},
		Status: corev1.PodStatus{Phase: phase},
	}
}

// A pod that passes Kubernetes' own availability condition can still have
// crashed moments later — this is the exact repro from issue #197. Its FIRST
// crash surfaces as Terminated (not yet Waiting/CrashLoopBackOff, which only
// appears after kubelet has cycled through several restarts), so CheckRollout
// must catch it via the Terminated branch, not just the Waiting branch.
func TestCheckRollout_TerminatedCrashBeforeBackoff(t *testing.T) {
	dep := availableDeployment(testApp, 1)
	pod := podWithLabels("my-app-abc-123", "dep-1", corev1.PodRunning)
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{
		{
			Name: "app",
			State: corev1.ContainerState{
				Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137},
			},
		},
	}
	client := fake.NewSimpleClientset(dep, pod)

	status, err := CheckRollout(context.Background(), client, testNamespace, testApp, "dep-1", AppliedWorkload{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status.Succeeded {
		t.Fatalf("expected rollout to fail on OOMKilled pod even with AvailableReplicas>=1, got succeeded message=%q", status.Message)
	}
	if !strings.Contains(status.Message, "OOMKilled") {
		t.Errorf("expected failure message to mention OOMKilled, got %q", status.Message)
	}
}

// The exact stale-pod bug from issue #197: a crashing pod left over from a
// PREVIOUS deployment of the same app must never be attributed to the
// CURRENT deployment's rollout check.
func TestCheckRollout_IgnoresStaleDeploymentPod(t *testing.T) {
	dep := availableDeployment(testApp, 1)
	stalePod := podWithLabels("my-app-old-111", "dep-old", corev1.PodRunning)
	stalePod.Status.ContainerStatuses = []corev1.ContainerStatus{
		{Name: "app", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}},
	}
	newPod := podWithLabels("my-app-new-222", "dep-new", corev1.PodRunning)
	newPod.Status.ContainerStatuses = []corev1.ContainerStatus{
		{Name: "app", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
	}
	client := fake.NewSimpleClientset(dep, stalePod, newPod)

	status, err := CheckRollout(context.Background(), client, testNamespace, testApp, "dep-new", AppliedWorkload{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !status.Succeeded {
		t.Fatalf("expected rollout to succeed using only the current deployment's healthy pod, got failed: %q", status.Message)
	}
	if status.PodName != "my-app-new-222" {
		t.Errorf("expected PodName to be the current deployment's pod, got %q", status.PodName)
	}
}

// Rollout completion must follow kubectl rollout status: a ready pod from the
// old ReplicaSet must not count towards the new rollout (issue #324).
func TestCheckRollout_Completion(t *testing.T) {
	cases := []struct {
		name     string
		strategy appsv1.DeploymentStrategyType
		desired  int32
		status   appsv1.DeploymentStatus
		done     bool
	}{
		{
			// The regression: maxSurge=1 creates the new pod while the old
			// one is still ready, so AvailableReplicas is already 1.
			name:     "rolling update, old pod ready, new pod not ready",
			strategy: appsv1.RollingUpdateDeploymentStrategyType,
			desired:  1,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 2, UpdatedReplicas: 1, AvailableReplicas: 1},
		},
		{
			name:     "rolling update, old pod gone, new pod not ready",
			strategy: appsv1.RollingUpdateDeploymentStrategyType,
			desired:  1,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 1, UpdatedReplicas: 1, AvailableReplicas: 0},
		},
		{
			name:     "rolling update, new pod available",
			strategy: appsv1.RollingUpdateDeploymentStrategyType,
			desired:  1,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 1, UpdatedReplicas: 1, AvailableReplicas: 1},
			done:     true,
		},
		{
			name:     "new spec not yet observed",
			strategy: appsv1.RollingUpdateDeploymentStrategyType,
			desired:  1,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 1, Replicas: 1, UpdatedReplicas: 1, AvailableReplicas: 1},
		},
		{
			name:     "recreate, old pod scaled down, new pod not created",
			strategy: appsv1.RecreateDeploymentStrategyType,
			desired:  1,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2},
		},
		{
			name:     "recreate, new pod not ready",
			strategy: appsv1.RecreateDeploymentStrategyType,
			desired:  1,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 1, UpdatedReplicas: 1, AvailableReplicas: 0},
		},
		{
			name:     "recreate, new pod available",
			strategy: appsv1.RecreateDeploymentStrategyType,
			desired:  1,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 1, UpdatedReplicas: 1, AvailableReplicas: 1},
			done:     true,
		},
		{
			name:     "3 replicas, not all updated",
			strategy: appsv1.RollingUpdateDeploymentStrategyType,
			desired:  3,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 4, UpdatedReplicas: 2, AvailableReplicas: 3},
		},
		{
			name:     "3 replicas, all updated, old pod still terminating",
			strategy: appsv1.RollingUpdateDeploymentStrategyType,
			desired:  3,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 4, UpdatedReplicas: 3, AvailableReplicas: 3},
		},
		{
			name:     "3 replicas, all updated, one not available",
			strategy: appsv1.RollingUpdateDeploymentStrategyType,
			desired:  3,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 3, UpdatedReplicas: 3, AvailableReplicas: 2},
		},
		{
			name:     "3 replicas, all updated and available",
			strategy: appsv1.RollingUpdateDeploymentStrategyType,
			desired:  3,
			status:   appsv1.DeploymentStatus{ObservedGeneration: 2, Replicas: 3, UpdatedReplicas: 3, AvailableReplicas: 3},
			done:     true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dep := availableDeployment(testApp, c.desired)
			dep.Generation = 2
			dep.Spec.Strategy.Type = c.strategy
			dep.Status = c.status
			oldPod := podWithLabels("my-app-old-111", "dep-old", corev1.PodRunning)
			newPod := podWithLabels("my-app-new-222", "dep-new", corev1.PodPending)
			client := fake.NewSimpleClientset(dep, oldPod, newPod)

			status, err := CheckRollout(context.Background(), client, testNamespace, testApp, "dep-new", AppliedWorkload{})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if status.Done != c.done {
				t.Fatalf("expected done=%v, got done=%v message=%q", c.done, status.Done, status.Message)
			}
			if c.done && !status.Succeeded {
				t.Errorf("expected rollout to succeed, got %q", status.Message)
			}
		})
	}
}

func TestCheckPodsForFailure_WaitingReasons(t *testing.T) {
	cases := []struct {
		reason string
		failed bool
	}{
		{"CrashLoopBackOff", true},
		{"ImagePullBackOff", true},
		{"ErrImagePull", true},
		{"ContainerCreating", false},
	}
	for _, c := range cases {
		pod := corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "p"},
			Status: corev1.PodStatus{
				ContainerStatuses: []corev1.ContainerStatus{
					{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: c.reason}}},
				},
			},
		}
		_, failed := checkPodsForFailure([]corev1.Pod{pod})
		if failed != c.failed {
			t.Errorf("reason %q: expected failed=%v, got %v", c.reason, c.failed, failed)
		}
	}
}

func TestCheckPodsForFailure_TerminatedNonZeroExit(t *testing.T) {
	pod := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "p"},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{
				{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}}},
			},
		},
	}
	msg, failed := checkPodsForFailure([]corev1.Pod{pod})
	if !failed {
		t.Fatal("expected a nonzero-exit Terminated container to be reported as failed")
	}
	if !strings.Contains(msg, "exit 1") {
		t.Errorf("expected message to include exit code, got %q", msg)
	}
}

func TestCheckPodsForFailure_TerminatedZeroExitIsNotFailure(t *testing.T) {
	pod := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "p"},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{
				{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed", ExitCode: 0}}},
			},
		},
	}
	_, failed := checkPodsForFailure([]corev1.Pod{pod})
	if failed {
		t.Error("expected a zero-exit-code Terminated container (Completed) not to be flagged as a failure")
	}
}

// A Deployment deleted and created again under the same name during the
// rollout is not the one canette applied (#332). Even fully available, it
// fails the rollout instead of being taken for it.
func TestCheckRollout_RecreatedDeployment(t *testing.T) {
	dep := availableDeployment(testApp, 1)
	dep.UID = "recreated"
	client := fake.NewSimpleClientset(dep, podWithLabels("my-app-abc-123", "dep-1", corev1.PodRunning))

	status, err := CheckRollout(context.Background(), client, testNamespace, testApp, "dep-1", AppliedWorkload{UID: "applied", Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !status.Done || status.Succeeded || !strings.Contains(status.Message, "created again") {
		t.Errorf("got %+v, want a failed rollout", status)
	}

	// Deleted and not created again.
	status, err = CheckRollout(context.Background(), fake.NewSimpleClientset(), testNamespace, testApp, "dep-1", AppliedWorkload{UID: "applied", Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !status.Done || status.Succeeded {
		t.Errorf("deleted: got %+v, want a failed rollout", status)
	}
}

// The rollout is done once Kubernetes has observed the applied generation,
// and then reports the Deployment's revision.
func TestCheckRollout_AppliedGeneration(t *testing.T) {
	dep := availableDeployment(testApp, 1)
	dep.UID = "applied"
	dep.Annotations = map[string]string{"deployment.kubernetes.io/revision": "7"}
	client := fake.NewSimpleClientset(dep)

	// The status counters are from generation 1, the apply wrote 2.
	status, err := CheckRollout(context.Background(), client, testNamespace, testApp, "dep-1", AppliedWorkload{UID: "applied", Generation: 2})
	if err != nil {
		t.Fatal(err)
	}
	if status.Done {
		t.Errorf("got %+v before the applied generation was observed", status)
	}

	status, err = CheckRollout(context.Background(), client, testNamespace, testApp, "dep-1", AppliedWorkload{UID: "applied", Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !status.Succeeded || status.Revision != "7" {
		t.Errorf("got %+v, want a success at revision 7", status)
	}
}
