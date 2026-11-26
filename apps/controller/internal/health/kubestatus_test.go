package health

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"go.uber.org/zap"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"

	"canette.dev/controller/internal/store"
	libk8s "canette.dev/lib/k8s"
)

type statusUpdate struct{ appID, statusJSON string }

type fakeStatusStore struct {
	current []store.CurrentDeployment
	updates []statusUpdate
}

func (f *fakeStatusStore) GetCurrentDeployments(_ context.Context) ([]store.CurrentDeployment, error) {
	return f.current, nil
}

func (f *fakeStatusStore) UpdateKubernetesStatus(_ context.Context, appID, statusJSON string) error {
	f.updates = append(f.updates, statusUpdate{appID, statusJSON})
	return nil
}

func newTestStatusReader(fs *fakeStatusStore, objs ...runtime.Object) (*StatusReader, *fake.Clientset) {
	client := fake.NewSimpleClientset(objs...)
	return &StatusReader{client: client, store: fs, log: zap.NewNop(), lastWritten: make(map[string]writtenVerdict)}, client
}

var testNS = libk8s.AppNamespace("proj-1", "proj")

func currentApp(deploymentType string) store.CurrentDeployment {
	return store.CurrentDeployment{
		AppID: "app-id-1", AppSlug: "app-1", ProjectID: "proj-1", ProjectSlug: "proj",
		DeploymentID: "dep-1", DeploymentType: deploymentType,
	}
}

// readOnce runs one pass and decodes the single status written.
func readOnce(t *testing.T, r *StatusReader, fs *fakeStatusStore) KubernetesStatus {
	t.Helper()
	before := len(fs.updates)
	if err := r.readAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fs.updates) != before+1 {
		t.Fatalf("got %d writes, want 1", len(fs.updates)-before)
	}
	var s KubernetesStatus
	if err := json.Unmarshal([]byte(fs.updates[len(fs.updates)-1].statusJSON), &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func int32Ptr(v int32) *int32 { return &v }
func boolPtr(v bool) *bool    { return &v }

func TestStatusReader_PartialAvailability(t *testing.T) {
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "app-1", Namespace: testNS},
		Spec:       appsv1.DeploymentSpec{Replicas: int32Ptr(3)},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 1, AvailableReplicas: 1, UpdatedReplicas: 3},
	}
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("web")}}
	r, _ := newTestStatusReader(fs, dep)

	s := readOnce(t, r, fs)
	if s.Workload != WorkloadPresent || s.Replicas == nil {
		t.Fatalf("got %+v, want a present Deployment with replicas", s)
	}
	if *s.Replicas != (ReplicaStatus{Desired: 3, Ready: 1, Available: 1, Updated: 3}) {
		t.Errorf("replicas = %+v", *s.Replicas)
	}
}

func TestStatusReader_MissingDeployment(t *testing.T) {
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("private")}}
	r, _ := newTestStatusReader(fs)

	if s := readOnce(t, r, fs); s.Workload != WorkloadMissing || s.Replicas != nil {
		t.Errorf("got %+v, want missing", s)
	}
}

func TestStatusReader_SuspendedCronJob(t *testing.T) {
	cj := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{Name: "app-1", Namespace: testNS, UID: "cj-uid"},
		Spec:       batchv1.CronJobSpec{Suspend: boolPtr(true)},
	}
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("cronjob")}}
	r, _ := newTestStatusReader(fs, cj)

	s := readOnce(t, r, fs)
	if s.Workload != WorkloadPresent || s.CronJob == nil || !s.CronJob.Suspended {
		t.Errorf("got %+v, want a suspended CronJob", s)
	}
}

func TestStatusReader_CronJobNeverRun(t *testing.T) {
	cj := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "app-1", Namespace: testNS, UID: "cj-uid"}}
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("cronjob")}}
	r, _ := newTestStatusReader(fs, cj)

	s := readOnce(t, r, fs)
	if s.CronJob == nil || s.CronJob.Suspended || s.CronJob.LastScheduleTime != nil || s.CronJob.LastJob != nil {
		t.Errorf("got %+v, want a CronJob that has never run", s.CronJob)
	}
}

func TestStatusReader_MissingCronJob(t *testing.T) {
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("cronjob")}}
	r, _ := newTestStatusReader(fs)

	if s := readOnce(t, r, fs); s.Workload != WorkloadMissing || s.CronJob != nil {
		t.Errorf("got %+v, want missing", s)
	}
}

func ownedJob(name string, owner types.UID, created time.Time, conds ...batchv1.JobCondition) *batchv1.Job {
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: testNS,
			CreationTimestamp: metav1.NewTime(created),
			OwnerReferences:   []metav1.OwnerReference{{Kind: "CronJob", Name: "app-1", UID: owner}},
		},
		Status: batchv1.JobStatus{Conditions: conds},
	}
}

func TestStatusReader_LatestJobOutcome(t *testing.T) {
	now := time.Now()
	sched := metav1.NewTime(now.Add(-time.Minute))
	cj := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{Name: "app-1", Namespace: testNS, UID: "cj-uid"},
		Status:     batchv1.CronJobStatus{LastScheduleTime: &sched},
	}
	complete := batchv1.JobCondition{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}
	failed := batchv1.JobCondition{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, Reason: "BackoffLimitExceeded"}
	objs := []runtime.Object{
		cj,
		ownedJob("older-ok", "cj-uid", now.Add(-2*time.Hour), complete),
		ownedJob("newest-failed", "cj-uid", now.Add(-time.Minute), failed),
		// Newer, but left by an earlier CronJob of the same name.
		ownedJob("other-owner", "old-uid", now, complete),
	}
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("cronjob")}}
	r, _ := newTestStatusReader(fs, objs...)

	s := readOnce(t, r, fs)
	if s.CronJob == nil || s.CronJob.LastScheduleTime == nil {
		t.Fatalf("got %+v, want a scheduled CronJob", s.CronJob)
	}
	job := s.CronJob.LastJob
	if job == nil || job.Name != "newest-failed" || job.Outcome != JobFailed || job.Reason != "BackoffLimitExceeded" {
		t.Errorf("lastJob = %+v, want newest-failed, failed, BackoffLimitExceeded", job)
	}
}

func TestStatusReader_RunningJob(t *testing.T) {
	cj := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "app-1", Namespace: testNS, UID: "cj-uid"}}
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("cronjob")}}
	r, _ := newTestStatusReader(fs, cj, ownedJob("run-1", "cj-uid", time.Now()))

	if job := readOnce(t, r, fs).CronJob.LastJob; job == nil || job.Outcome != JobRunning {
		t.Errorf("lastJob = %+v, want running", job)
	}
}

func TestStatusReader_FailedReadKeepsStoredStatus(t *testing.T) {
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("web")}}
	r, client := newTestStatusReader(fs)
	client.PrependReactor("get", "deployments", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("connection refused")
	})

	if err := r.readAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fs.updates) != 0 {
		t.Errorf("got %d writes, want none: a failed read must leave the status to go stale", len(fs.updates))
	}
}

func TestStatusReader_DebouncesUnchangedStatus(t *testing.T) {
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "app-1", Namespace: testNS},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 1, AvailableReplicas: 1, UpdatedReplicas: 1},
	}
	fs := &fakeStatusStore{current: []store.CurrentDeployment{currentApp("web")}}
	r, _ := newTestStatusReader(fs, dep)
	ctx := context.Background()

	for range 2 {
		if err := r.readAll(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(fs.updates) != 1 {
		t.Fatalf("got %d writes, want 1 for an unchanged status", len(fs.updates))
	}

	// Once healthRewriteInterval old, the unchanged status is written again
	// so kubernetes_status_observed_at stays fresh.
	last := r.lastWritten["app-id-1"]
	last.at = last.at.Add(-healthRewriteInterval)
	r.lastWritten["app-id-1"] = last
	if err := r.readAll(ctx); err != nil {
		t.Fatal(err)
	}
	if len(fs.updates) != 2 {
		t.Errorf("got %d writes, want the due rewrite", len(fs.updates))
	}

	// An app that is no longer live drops its debounce state.
	fs.current = nil
	if err := r.readAll(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.lastWritten["app-id-1"]; ok {
		t.Error("lastWritten kept an app that is no longer live")
	}
}
