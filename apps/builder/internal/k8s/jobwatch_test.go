package k8s

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"
)

const (
	watchTestNamespace = "canette-build"
	watchTestJob       = "build-abc"
)

func init() { watchRetryDelay = time.Millisecond }

func testJob(rv string, mutate func(*batchv1.Job)) *batchv1.Job {
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{
		Name: watchTestJob, Namespace: watchTestNamespace, ResourceVersion: rv,
	}}
	if mutate != nil {
		mutate(job)
	}
	return job
}

func succeeded(j *batchv1.Job) { j.Status.Succeeded = 1 }

func failed(j *batchv1.Job) {
	j.Status.Conditions = []batchv1.JobCondition{{
		Type: batchv1.JobFailed, Status: corev1.ConditionTrue, Reason: "BackoffLimitExceeded",
	}}
}

// scriptedWatches serves one prepared watch per Watch call, each holding the
// given events, and records the resourceVersion every call asked for. A watch
// whose script ends without a terminal event is closed, like a watch the
// apiserver ends.
type scriptedWatches struct {
	mu      sync.Mutex
	scripts [][]watch.Event
	calls   []string // ResourceVersion of each Watch call
}

func (s *scriptedWatches) install(client *fake.Clientset) {
	client.PrependWatchReactor("jobs", func(action clienttesting.Action) (bool, watch.Interface, error) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.calls = append(s.calls, action.(clienttesting.WatchActionImpl).WatchRestrictions.ResourceVersion)
		if len(s.scripts) == 0 {
			// Nothing scripted: a watch that never delivers anything.
			return true, watch.NewFake(), nil
		}
		events := s.scripts[0]
		s.scripts = s.scripts[1:]
		w := watch.NewFakeWithChanSize(len(events), false)
		for _, e := range events {
			w.Action(e.Type, e.Object)
		}
		w.Stop() // buffered events are still delivered before the close
		return true, w, nil
	})
}

func watchErrorEvent(err *apierrors.StatusError) watch.Event {
	status := err.Status()
	return watch.Event{Type: watch.Error, Object: &status}
}

func expired() *apierrors.StatusError {
	return apierrors.NewResourceExpired("too old resource version: 5 (12)")
}

func waitForTestJob(t *testing.T, client *fake.Clientset) (bool, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return WaitForJob(ctx, client, watchTestNamespace, watchTestJob, zap.NewNop())
}

func TestWaitForJob_Outcomes(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event watch.Event
		want  bool
	}{
		{"succeeded", watch.Event{Type: watch.Modified, Object: testJob("2", succeeded)}, true},
		{"failed", watch.Event{Type: watch.Modified, Object: testJob("2", failed)}, false},
		{"deleted after succeeding", watch.Event{Type: watch.Deleted, Object: testJob("3", succeeded)}, true},
		{"deleted after failing", watch.Event{Type: watch.Deleted, Object: testJob("3", failed)}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := fake.NewSimpleClientset()
			(&scriptedWatches{scripts: [][]watch.Event{{
				{Type: watch.Added, Object: testJob("1", nil)},
				tc.event,
			}}}).install(client)

			got, err := waitForTestJob(t, client)
			if err != nil || got != tc.want {
				t.Fatalf("got (%v, %v), want (%v, nil)", got, err, tc.want)
			}
		})
	}
}

func TestWaitForJob_DeletedBeforeFinishing(t *testing.T) {
	client := fake.NewSimpleClientset()
	(&scriptedWatches{scripts: [][]watch.Event{{
		{Type: watch.Added, Object: testJob("1", nil)},
		{Type: watch.Deleted, Object: testJob("2", nil)},
	}}}).install(client)

	_, err := waitForTestJob(t, client)
	if err == nil || !strings.Contains(err.Error(), "deleted before it finished") {
		t.Fatalf("got err=%v, want a deleted-before-finishing error", err)
	}
}

func TestWaitForJob_WatchErrorThenSuccess(t *testing.T) {
	// The Job is still running when it is read again after the error.
	client := fake.NewSimpleClientset(testJob("7", nil))
	w := &scriptedWatches{scripts: [][]watch.Event{
		{{Type: watch.Added, Object: testJob("5", nil)}, watchErrorEvent(expired())},
		{{Type: watch.Modified, Object: testJob("8", succeeded)}},
	}}
	w.install(client)

	got, err := waitForTestJob(t, client)
	if err != nil || !got {
		t.Fatalf("got (%v, %v), want (true, nil)", got, err)
	}
	// The second watch resumes from the Job's current resourceVersion, not the
	// expired one.
	if len(w.calls) != 2 || w.calls[0] != "" || w.calls[1] != "7" {
		t.Errorf("watch calls asked for resourceVersions %q, want [\"\" \"7\"]", w.calls)
	}
}

func TestWaitForJob_WatchErrorAfterJobFinished(t *testing.T) {
	client := fake.NewSimpleClientset(testJob("9", failed))
	w := &scriptedWatches{scripts: [][]watch.Event{
		{watchErrorEvent(expired())},
	}}
	w.install(client)

	got, err := waitForTestJob(t, client)
	if err != nil || got {
		t.Fatalf("got (%v, %v), want (false, nil)", got, err)
	}
	if len(w.calls) != 1 {
		t.Errorf("expected no new watch once the Job was read as finished, got %d calls", len(w.calls))
	}
}

func TestWaitForJob_WatchErrorAndJobGone(t *testing.T) {
	client := fake.NewSimpleClientset()
	(&scriptedWatches{scripts: [][]watch.Event{
		{watchErrorEvent(apierrors.NewInternalError(context.DeadlineExceeded))},
	}}).install(client)

	_, err := waitForTestJob(t, client)
	if err == nil || !strings.Contains(err.Error(), "no longer exists") {
		t.Fatalf("got err=%v, want a no-longer-exists error", err)
	}
}

func TestWaitForJob_WatchCallReturnsExpired(t *testing.T) {
	client := fake.NewSimpleClientset(testJob("4", succeeded))
	client.PrependWatchReactor("jobs", func(clienttesting.Action) (bool, watch.Interface, error) {
		return true, nil, expired()
	})

	got, err := waitForTestJob(t, client)
	if err != nil || !got {
		t.Fatalf("got (%v, %v), want (true, nil)", got, err)
	}
}

func TestWaitForJob_OtherWatchCallErrorFails(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependWatchReactor("jobs", func(clienttesting.Action) (bool, watch.Interface, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "batch", Resource: "jobs"}, watchTestJob, nil)
	})

	if _, err := waitForTestJob(t, client); err == nil || !apierrors.IsForbidden(err) {
		t.Fatalf("got err=%v, want the Forbidden error", err)
	}
}

func TestWaitForJob_ClosedWatchResumesFromLastResourceVersion(t *testing.T) {
	client := fake.NewSimpleClientset()
	w := &scriptedWatches{scripts: [][]watch.Event{
		{{Type: watch.Added, Object: testJob("3", nil)}}, // closes without an outcome
		{{Type: watch.Modified, Object: testJob("4", succeeded)}},
	}}
	w.install(client)

	got, err := waitForTestJob(t, client)
	if err != nil || !got {
		t.Fatalf("got (%v, %v), want (true, nil)", got, err)
	}
	if len(w.calls) != 2 || w.calls[1] != "3" {
		t.Errorf("watch calls asked for resourceVersions %q, want the second to resume from \"3\"", w.calls)
	}
}

func TestWaitForJob_ContextCancelled(t *testing.T) {
	client := fake.NewSimpleClientset()
	(&scriptedWatches{}).install(client) // a watch that never delivers anything

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := WaitForJob(ctx, client, watchTestNamespace, watchTestJob, zap.NewNop()); err != context.DeadlineExceeded {
		t.Fatalf("got err=%v, want context.DeadlineExceeded", err)
	}
}
