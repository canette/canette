package controller

import (
	"context"
	"database/sql"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/zap/zaptest"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"

	k8sres "canette.dev/controller/internal/k8s"
	"canette.dev/controller/internal/store"
	"canette.dev/controller/internal/storetest"
)

// These tests run an app worker against a real Postgres (see storetest) and
// fake Kubernetes clients, on app a1 ("a") of project p1 ("p") from
// storetest.SeedProject. The fake dynamic client can't server-side apply,
// so applyAll only counts calls, and checkRollout is scripted per test.

const appNS = "can-p1-p"

var testGVRDeployment = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}

type lifecycleFixture struct {
	t       *testing.T
	c       *Controller
	db      *sql.DB
	dyn     *dynamicfake.FakeDynamicClient
	applies atomic.Int32
}

func newLifecycleFixture(t *testing.T) *lifecycleFixture {
	t.Helper()
	db := storetest.DB(t)
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{{Version: "v1", Resource: "configmaps"}: "ConfigMapList"},
		&unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "apps/v1", "kind": "Deployment",
			"metadata": map[string]interface{}{"name": "a", "namespace": appNS},
		}})
	f := &lifecycleFixture{t: t, db: db, dyn: dyn}
	f.c = New(store.New(db, zaptest.NewLogger(t)), fake.NewSimpleClientset(), dyn,
		Config{ClusterDomain: "example.com", MaxConcurrent: 3}, nil, zaptest.NewLogger(t), nil)
	f.c.applyAll = func(context.Context, dynamic.Interface, k8sres.AppResources) (k8sres.AppliedWorkload, error) {
		f.applies.Add(1)
		return k8sres.AppliedWorkload{UID: "uid-1", Generation: 3}, nil
	}
	f.c.rolloutPollInterval = 10 * time.Millisecond
	f.rollout(func(int) k8sres.RolloutStatus {
		return k8sres.RolloutStatus{Done: true, Succeeded: true, Message: "rolled out"}
	})
	return f
}

// rollout scripts checkRollout: status gets the 1-based number of the poll.
func (f *lifecycleFixture) rollout(status func(poll int) k8sres.RolloutStatus) {
	var polls atomic.Int32
	f.c.checkRollout = func(context.Context, kubernetes.Interface, string, string, string, k8sres.AppliedWorkload) (k8sres.RolloutStatus, error) {
		return status(int(polls.Add(1))), nil
	}
}

func (f *lifecycleFixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Exec(q, args...); err != nil {
		f.t.Fatalf("%s: %v", q, err)
	}
}

// deployment adds an attempt of a1 with status.
func (f *lifecycleFixture) deployment(id, status string) {
	f.t.Helper()
	now := time.Now().UTC().Add(-time.Hour)
	f.exec(`INSERT INTO deployments (id, app_id, status, commit_sha, image_digest, deployment_snapshot, created_at, updated_at)
		VALUES ($1, 'a1', $2, 'abc', 'sha256:abc',
		        '{"app":{"id":"a1","slug":"a","deployment_type":"web"},"project":{"id":"p1","slug":"p"}}', $3, $3)`,
		id, status, now)
}

// intent sets a1's intent the way the API does: generation + 1.
func (f *lifecycleFixture) intent(desired, target string) {
	f.t.Helper()
	var t any
	if target != "" {
		t = target
	}
	f.exec(`INSERT INTO app_intents (app_id, generation, desired_state, target_deployment_id, updated_at)
		VALUES ('a1', 1, $1, $2, CURRENT_TIMESTAMP)
		ON CONFLICT (app_id) DO UPDATE SET generation = app_intents.generation + 1,
		  desired_state = excluded.desired_state,
		  target_deployment_id = COALESCE(excluded.target_deployment_id, app_intents.target_deployment_id),
		  updated_at = excluded.updated_at`, desired, t)
}

func (f *lifecycleFixture) claim() store.Lease {
	f.t.Helper()
	leases, err := f.c.store.ClaimApps(context.Background(), 10, nil)
	if err != nil || len(leases) != 1 {
		f.t.Fatalf("claimed %+v, err %v; want a1", leases, err)
	}
	return leases[0]
}

func (f *lifecycleFixture) run(ctx context.Context) {
	f.t.Helper()
	f.c.runApp(ctx, f.claim())
}

func (f *lifecycleFixture) status(id string) string {
	f.t.Helper()
	var s string
	if err := f.db.QueryRow(`SELECT status FROM deployments WHERE id = $1`, id).Scan(&s); err != nil {
		f.t.Fatal(err)
	}
	return s
}

type runtimeState struct {
	reconciled, generation int64
	applied, liveURL       sql.NullString
	leased                 bool
}

func (f *lifecycleFixture) runtime() runtimeState {
	f.t.Helper()
	var r runtimeState
	if err := f.db.QueryRow(`SELECT r.reconciled_generation, i.generation, r.applied_deployment_id, r.live_url, r.lease_token IS NOT NULL
		FROM app_runtime r JOIN app_intents i ON i.app_id = r.app_id WHERE r.app_id = 'a1'`).
		Scan(&r.reconciled, &r.generation, &r.applied, &r.liveURL, &r.leased); err != nil {
		f.t.Fatal(err)
	}
	return r
}

func (f *lifecycleFixture) workloadExists() bool {
	f.t.Helper()
	_, err := f.dyn.Resource(testGVRDeployment).Namespace(appNS).Get(context.Background(), "a", metav1.GetOptions{})
	if err != nil && !errors.IsNotFound(err) {
		f.t.Fatal(err)
	}
	return err == nil
}

func TestRunApp_DeploysTarget(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("old", "live")
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")

	f.run(context.Background())

	if got := f.status("d1"); got != "live" {
		t.Errorf("d1 is %s, want live", got)
	}
	if got := f.status("old"); got != "superseded" {
		t.Errorf("old is %s, want superseded", got)
	}
	r := f.runtime()
	if r.reconciled != r.generation || r.applied.String != "d1" || r.liveURL.String != "https://a-p.example.com" || r.leased {
		t.Errorf("runtime %+v", r)
	}
	if n := f.applies.Load(); n != 1 {
		t.Errorf("applied %d times, want 1", n)
	}
}

// The rollout is checked against the workload the apply wrote, and the app's
// runtime and the attempt record it with the revision the rollout reached
// (#332). A failed attempt keeps what it applied.
func TestRunApp_RecordsAppliedWorkload(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	var checked atomic.Value
	f.c.checkRollout = func(_ context.Context, _ kubernetes.Interface, _, _, _ string, applied k8sres.AppliedWorkload) (k8sres.RolloutStatus, error) {
		checked.Store(applied)
		return k8sres.RolloutStatus{Done: true, Succeeded: true, Message: "rolled out", Revision: "5"}, nil
	}

	f.run(context.Background())

	if got, _ := checked.Load().(k8sres.AppliedWorkload); got != (k8sres.AppliedWorkload{UID: "uid-1", Generation: 3}) {
		t.Errorf("rollout checked against %+v, want the applied uid-1 at generation 3", got)
	}
	want := [3]string{"uid-1", "3", "5"}
	for _, q := range []string{
		`SELECT applied_workload_uid, applied_workload_generation::text, applied_workload_revision FROM app_runtime WHERE app_id = 'a1'`,
		`SELECT workload_uid, workload_generation::text, workload_revision FROM deployments WHERE id = 'd1'`,
	} {
		var got [3]string
		if err := f.db.QueryRow(q).Scan(&got[0], &got[1], &got[2]); err != nil || got != want {
			t.Errorf("%s: %v, err %v; want %v", q, got, err, want)
		}
	}

	f.deployment("d2", "pending_deployment")
	f.intent("running", "d2")
	f.rollout(func(int) k8sres.RolloutStatus { return k8sres.RolloutStatus{Done: true, Message: "pods crash"} })
	f.run(context.Background())

	var uid string
	var revision sql.NullString
	if err := f.db.QueryRow(`SELECT workload_uid, workload_revision FROM deployments WHERE id = 'd2'`).Scan(&uid, &revision); err != nil ||
		uid != "uid-1" || revision.Valid {
		t.Errorf("failed d2: uid %q revision %v, err %v; want uid-1 and no revision", uid, revision, err)
	}
	// The app still runs what d1 applied.
	if r := f.runtime(); r.applied.String != "d1" {
		t.Errorf("runtime %+v, want d1 applied", r)
	}
}

func TestRunApp_RolloutFails(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	f.rollout(func(int) k8sres.RolloutStatus { return k8sres.RolloutStatus{Done: true, Message: "pods crash"} })

	f.run(context.Background())

	if got := f.status("d1"); got != "failed" {
		t.Errorf("d1 is %s, want failed", got)
	}
	// Reconciled, so the failed attempt isn't retried.
	if r := f.runtime(); r.reconciled != r.generation || r.applied.Valid || r.leased {
		t.Errorf("runtime %+v", r)
	}
}

func TestRunApp_Stops(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "live")
	f.intent("running", "d1")
	f.exec(`INSERT INTO app_runtime (app_id, reconciled_generation, applied_deployment_id, live_url)
		VALUES ('a1', 1, 'd1', 'https://a-p.example.com')`)
	f.intent("stopped", "")

	f.run(context.Background())

	if f.workloadExists() {
		t.Error("the Deployment is still there")
	}
	if got := f.status("d1"); got != "stopped" {
		t.Errorf("d1 is %s, want stopped", got)
	}
	if r := f.runtime(); r.reconciled != 2 || r.applied.Valid || r.liveURL.Valid || r.leased {
		t.Errorf("runtime %+v", r)
	}
	if n := f.applies.Load(); n != 0 {
		t.Errorf("applied %d times, want none", n)
	}
}

func TestRunApp_StopDuringRollout(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	f.rollout(func(poll int) k8sres.RolloutStatus {
		if poll == 1 {
			f.intent("stopped", "") // Stop arrives while the rollout runs
		}
		return k8sres.RolloutStatus{Message: "waiting"}
	})

	f.run(context.Background())

	if got := f.status("d1"); got != "stopped" {
		t.Errorf("d1 is %s, want stopped", got)
	}
	if f.workloadExists() {
		t.Error("the Deployment is still there")
	}
	if r := f.runtime(); r.reconciled != 2 || r.applied.Valid || r.leased {
		t.Errorf("runtime %+v", r)
	}
}

func TestRunApp_NewerTargetReadyDuringRollout(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	f.rollout(func(poll int) k8sres.RolloutStatus {
		if poll == 1 {
			f.deployment("d2", "pending_deployment")
			f.intent("running", "d2")
			return k8sres.RolloutStatus{Message: "waiting"}
		}
		return k8sres.RolloutStatus{Done: true, Succeeded: true, Message: "rolled out"}
	})

	f.run(context.Background())

	if got := f.status("d1"); got != "superseded" {
		t.Errorf("d1 is %s, want superseded", got)
	}
	if got := f.status("d2"); got != "live" {
		t.Errorf("d2 is %s, want live", got)
	}
	if r := f.runtime(); r.reconciled != r.generation || r.applied.String != "d2" {
		t.Errorf("runtime %+v", r)
	}
}

func TestRunApp_NewerTargetBuildingDuringRollout(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	f.rollout(func(poll int) k8sres.RolloutStatus {
		if poll == 1 {
			f.deployment("d2", "building") // a push lands during the rollout
			f.intent("running", "d2")
			return k8sres.RolloutStatus{Message: "waiting"}
		}
		return k8sres.RolloutStatus{Done: true, Succeeded: true, Message: "rolled out"}
	})

	f.run(context.Background())

	// d1 is what serves until d2 is built, so it still goes live.
	if got := f.status("d1"); got != "live" {
		t.Errorf("d1 is %s, want live", got)
	}
	r := f.runtime()
	if r.applied.String != "d1" || r.reconciled != 1 || r.generation != 2 || r.leased {
		t.Errorf("runtime %+v, want d1 applied and generation 2 still to do", r)
	}
	if leases, err := f.c.store.ClaimApps(context.Background(), 10, nil); err != nil || len(leases) != 0 {
		t.Errorf("claimed %+v while d2 builds, err %v", leases, err)
	}

	// Once built, d2 is rolled out.
	f.exec(`UPDATE deployments SET status = 'pending_deployment' WHERE id = 'd2'`)
	f.run(context.Background())
	if got := f.status("d2"); got != "live" {
		t.Errorf("d2 is %s, want live", got)
	}
	if got := f.status("d1"); got != "superseded" {
		t.Errorf("d1 is %s, want superseded", got)
	}
}

func TestDeploy_IntentChangedBeforeApply(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	lease := f.claim()
	in, err := f.c.store.ReadIntent(context.Background(), "a1")
	if err != nil {
		t.Fatal(err)
	}
	// A newer deploy is accepted after the worker read the intent.
	f.deployment("d2", "pending_deployment")
	f.intent("running", "d2")

	if again := f.c.deploy(context.Background(), f.c.log, lease, in); !again {
		t.Error("deploy should ask to read the intent again")
	}
	if n := f.applies.Load(); n != 0 {
		t.Errorf("applied %d times, want none: the fence must refuse", n)
	}
	if got := f.status("d1"); got != "superseded" {
		t.Errorf("d1 is %s, want superseded", got)
	}
}

func TestRunApp_ShutdownResumes(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	ctx, cancel := context.WithCancel(context.Background())
	f.rollout(func(int) k8sres.RolloutStatus {
		cancel() // the controller shuts down during the rollout
		return k8sres.RolloutStatus{Message: "waiting"}
	})

	f.run(ctx)

	// Nothing is failed, and the lease is given up for the next controller.
	if got := f.status("d1"); got != "deploying" {
		t.Errorf("d1 is %s, want deploying", got)
	}
	if r := f.runtime(); r.reconciled != 0 || r.leased {
		t.Errorf("runtime %+v", r)
	}

	f.rollout(func(int) k8sres.RolloutStatus {
		return k8sres.RolloutStatus{Done: true, Succeeded: true, Message: "rolled out"}
	})
	f.run(context.Background())
	if got := f.status("d1"); got != "live" {
		t.Errorf("after resuming, d1 is %s, want live", got)
	}
	if n := f.applies.Load(); n != 2 {
		t.Errorf("applied %d times, want 2 (once more on resume)", n)
	}
}

// A rollout whose fenced apply worked but whose transaction was lost before
// it committed is resumed, not failed.
func TestRunApp_LostFenceResumes(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	f.c.applyAll = func(context.Context, dynamic.Interface, k8sres.AppResources) (k8sres.AppliedWorkload, error) {
		f.applies.Add(1)
		if f.applies.Load() == 1 {
			f.exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
				WHERE state = 'idle in transaction' AND query LIKE '%lease_token = $2 FOR SHARE%'`)
		}
		return k8sres.AppliedWorkload{}, nil
	}

	f.run(context.Background())

	if got := f.status("d1"); got != "deploying" {
		t.Errorf("d1 is %s, want deploying (unconfirmed, not failed)", got)
	}
	if r := f.runtime(); r.reconciled != 0 || r.leased {
		t.Errorf("runtime %+v", r)
	}

	f.run(context.Background())
	if got := f.status("d1"); got != "live" {
		t.Errorf("after resuming, d1 is %s, want live", got)
	}
}

func TestProcessPending_SweepsAndClaims(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("stopped", "d1") // stopped while it was building

	ctx := context.Background()
	if err := f.c.processPending(ctx, ctx); err != nil {
		t.Fatal(err)
	}
	if !f.c.waitWorkers(10 * time.Second) {
		t.Fatal("workers did not finish")
	}
	if got := f.status("d1"); got != "superseded" {
		t.Errorf("d1 is %s, want superseded", got)
	}
	if n := f.applies.Load(); n != 0 {
		t.Errorf("applied %d times, want none", n)
	}
	if r := f.runtime(); r.reconciled != r.generation || r.leased {
		t.Errorf("runtime %+v", r)
	}
}

// A restart while a rollout waited for a newer target still being built cuts
// the wait off and leaves the rollout deploying. It is retired once the newer
// target takes over.
func TestRunApp_RolloutCutOffByRestartIsRetired(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "pending_deployment")
	f.intent("running", "d1")
	ctx, cancel := context.WithCancel(context.Background())
	f.rollout(func(poll int) k8sres.RolloutStatus {
		if poll == 1 {
			f.deployment("d2", "building") // a newer push
			f.intent("running", "d2")
		} else {
			cancel() // the controller restarts while d1 still rolls out
		}
		return k8sres.RolloutStatus{Message: "waiting"}
	})
	f.run(ctx)
	if got := f.status("d1"); got != "deploying" {
		t.Fatalf("d1 is %s after the restart, want deploying", got)
	}

	f.exec(`UPDATE deployments SET status = 'pending_deployment' WHERE id = 'd2'`) // d2 is built
	f.rollout(func(int) k8sres.RolloutStatus {
		return k8sres.RolloutStatus{Done: true, Succeeded: true, Message: "rolled out"}
	})
	f.run(context.Background())

	if got := f.status("d2"); got != "live" {
		t.Errorf("d2 is %s, want live", got)
	}
	if got := f.status("d1"); got != "superseded" {
		t.Errorf("d1 is %s, want superseded once d2 took over", got)
	}
}

// An admin repair bumps the intent with the same, live target: the worker
// applies it again and checks the rollout, and the history is left as it is.
func TestRunApp_RepairReappliesLiveTarget(t *testing.T) {
	f := newLifecycleFixture(t)
	f.deployment("d1", "live")
	f.intent("running", "d1")
	f.exec(`INSERT INTO app_runtime (app_id, reconciled_generation, applied_deployment_id) VALUES ('a1', 1, 'd1')`)
	f.intent("running", "") // the repair: generation 2, same target

	f.run(context.Background())

	if n := f.applies.Load(); n != 1 {
		t.Errorf("applied %d times, want once", n)
	}
	if got := f.status("d1"); got != "live" {
		t.Errorf("d1 is %s, want live", got)
	}
	if r := f.runtime(); r.reconciled != 2 || r.applied.String != "d1" || r.leased {
		t.Errorf("runtime %+v", r)
	}
}
