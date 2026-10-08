package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	libk8s "canette.dev/lib/k8s"
)

const (
	testProjectID   = "0b5c2a9e-6f1d-4c3b-9a8e-1d2f3a4b5c6d"
	testProjectSlug = "demo"
	testApp         = "web"
)

func testPod(name string, created time.Time, labels map[string]string, status corev1.PodStatus) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         libk8s.AppNamespace(testProjectID, testProjectSlug),
			Labels:            labels,
			CreationTimestamp: metav1.NewTime(created),
		},
		Spec:   corev1.PodSpec{Containers: []corev1.Container{{Name: "authgate"}, {Name: testApp}}},
		Status: status,
	}
}

func getTail(t *testing.T, h http.Handler, query string) tailResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/logs/tail?project_id="+testProjectID+"&project_slug="+testProjectSlug+"&app="+testApp+query, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp tailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

func TestLogsTail_NoPods(t *testing.T) {
	h := logsTailHandler(zap.NewNop(), fake.NewClientset())
	resp := getTail(t, h, "")
	if resp.Found {
		t.Fatalf("Found = true, want false")
	}
}

func TestLogsTail_PicksNewestPodAndReportsCrashStatus(t *testing.T) {
	labels := map[string]string{libk8s.LabelApp: testApp}
	now := time.Now()
	old := testPod("web-old", now.Add(-time.Hour), labels, corev1.PodStatus{Phase: corev1.PodRunning})
	crashing := testPod("web-new", now, labels, corev1.PodStatus{
		Phase: corev1.PodRunning,
		ContainerStatuses: []corev1.ContainerStatus{{
			Name:         testApp,
			RestartCount: 4,
			State:        corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
			LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
				Reason: "Error", ExitCode: 1,
			}},
		}},
	})
	h := logsTailHandler(zap.NewNop(), fake.NewClientset(old, crashing))

	resp := getTail(t, h, "&lines=50")
	if !resp.Found || resp.Pod != "web-new" {
		t.Fatalf("Pod = %q (found=%v), want web-new", resp.Pod, resp.Found)
	}
	if resp.Restarts != 4 || resp.WaitingReason != "CrashLoopBackOff" {
		t.Errorf("Restarts = %d, WaitingReason = %q", resp.Restarts, resp.WaitingReason)
	}
	if resp.LastTerminationReason != "Error" || resp.LastExitCode == nil || *resp.LastExitCode != 1 {
		t.Errorf("LastTermination = %q / %v", resp.LastTerminationReason, resp.LastExitCode)
	}
	// The fake clientset always returns "fake logs" for GetLogs.
	if resp.Logs == "" {
		t.Errorf("Logs empty, want fake log body")
	}
}

func TestLogsTail_RejectsInvalidLines(t *testing.T) {
	h := logsTailHandler(zap.NewNop(), fake.NewClientset())
	req := httptest.NewRequest(http.MethodGet, "/logs/tail?project_id="+testProjectID+"&project_slug="+testProjectSlug+"&app="+testApp+"&lines=-3", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAppContainerName_SkipsSidecar(t *testing.T) {
	pod := testPod("p", time.Now(), nil, corev1.PodStatus{})
	if got := appContainerName(pod, testApp); got != testApp {
		t.Fatalf("appContainerName = %q, want %q", got, testApp)
	}
}
