package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"testing"
	"time"
)

// lifecycleApp seeds app id with an intent and a runtime row, and returns the
// time its intent was written. Deployments added before that time count as
// recorded by the intent, ones added after it as written by an old API.
type lifecycleApp struct {
	id         string
	desired    string
	generation int64
	target     string
	reconciled int64
	token      string
	claimedAt  *time.Time
}

var intentWritten = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

func addLifecycleApp(t *testing.T, db *sql.DB, a lifecycleApp, deps ...[2]string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO apps (id, project_id, name, slug, created_at, updated_at)
		VALUES ($1, 'p1', $1, $1, $2, $2)`, a.id, intentWritten); err != nil {
		t.Fatalf("insert app %s: %v", a.id, err)
	}
	for _, d := range deps {
		addAttempt(t, db, a.id, d[0], d[1], intentWritten.Add(-time.Hour))
	}
	var target any
	if a.target != "" {
		target = a.target
	}
	if _, err := db.Exec(`INSERT INTO app_intents (app_id, generation, desired_state, target_deployment_id, updated_at)
		VALUES ($1, $2, $3, $4, $5)`, a.id, a.generation, a.desired, target, intentWritten); err != nil {
		t.Fatalf("insert intent %s: %v", a.id, err)
	}
	var token any
	if a.token != "" {
		token = a.token
	}
	if _, err := db.Exec(`INSERT INTO app_runtime (app_id, reconciled_generation, lease_token, claimed_at)
		VALUES ($1, $2, $3, $4)`, a.id, a.reconciled, token, a.claimedAt); err != nil {
		t.Fatalf("insert runtime %s: %v", a.id, err)
	}
}

// addAttempt adds deployment id of app with status, created at created.
func addAttempt(t *testing.T, db *sql.DB, appID, id, status string, created time.Time) {
	t.Helper()
	snapshot := `{"app":{"id":"` + appID + `","slug":"` + appID + `"},"project":{"id":"p1","slug":"p"}}`
	if _, err := db.Exec(`
		INSERT INTO deployments (id, app_id, status, commit_sha, image_digest, deployment_snapshot, created_at, updated_at)
		VALUES ($1, $2, $3, 'abc', 'sha256:abc', $4, $5, $5)`, id, appID, status, snapshot, created); err != nil {
		t.Fatalf("insert deployment %s: %v", id, err)
	}
}

func statusOf(t *testing.T, db *sql.DB, id string) string {
	t.Helper()
	status, _, _ := deploymentState(t, db, id)
	return status
}

type runtimeRow struct {
	reconciled int64
	applied    sql.NullString
	liveURL    sql.NullString
	token      sql.NullString
	lastError  sql.NullString
}

func runtimeOf(t *testing.T, db *sql.DB, appID string) runtimeRow {
	t.Helper()
	var r runtimeRow
	if err := db.QueryRow(`SELECT reconciled_generation, applied_deployment_id, live_url, lease_token, last_error
		FROM app_runtime WHERE app_id = $1`, appID).Scan(&r.reconciled, &r.applied, &r.liveURL, &r.token, &r.lastError); err != nil {
		t.Fatal(err)
	}
	return r
}

func claimedIDs(leases []Lease) []string {
	ids := make([]string, 0, len(leases))
	for _, l := range leases {
		ids = append(ids, l.AppID)
	}
	slices.Sort(ids)
	return ids
}

func TestClaimApps(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	fresh := time.Now()
	expired := time.Now().Add(-AppLeaseTTL - time.Minute)

	addLifecycleApp(t, db, lifecycleApp{id: "deploy", desired: "running", generation: 2, target: "deploy-d", reconciled: 1},
		[2]string{"deploy-d", "pending_deployment"})
	addLifecycleApp(t, db, lifecycleApp{id: "building", desired: "running", generation: 2, target: "building-d", reconciled: 1},
		[2]string{"building-d", "building"})
	addLifecycleApp(t, db, lifecycleApp{id: "stop", desired: "stopped", generation: 2, target: "stop-d", reconciled: 1},
		[2]string{"stop-d", "building"})
	addLifecycleApp(t, db, lifecycleApp{id: "done", desired: "running", generation: 1, target: "done-d", reconciled: 1},
		[2]string{"done-d", "live"})
	addLifecycleApp(t, db, lifecycleApp{id: "leased", desired: "stopped", generation: 2, reconciled: 1, token: "other", claimedAt: &fresh})
	addLifecycleApp(t, db, lifecycleApp{id: "expired", desired: "stopped", generation: 2, reconciled: 1, token: "dead", claimedAt: &expired})
	addLifecycleApp(t, db, lifecycleApp{id: "here", desired: "stopped", generation: 2, reconciled: 1})

	leases, err := s.ClaimApps(ctx, 10, []string{"here"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"deploy", "expired", "stop"}
	if got := claimedIDs(leases); !slices.Equal(got, want) {
		t.Fatalf("claimed %v, want %v", got, want)
	}
	if r := runtimeOf(t, db, "deploy"); r.token.String != leases[0].Token {
		t.Errorf("deploy: lease token %q, want %q", r.token.String, leases[0].Token)
	}

	// Leased apps are not claimed again, and the limit holds.
	if more, err := s.ClaimApps(ctx, 10, nil); err != nil || !slices.Equal(claimedIDs(more), []string{"here"}) {
		t.Fatalf("second claim: %v, err %v; want only [here]", claimedIDs(more), err)
	}
	if _, err := db.Exec(`UPDATE app_runtime SET lease_token = NULL, claimed_at = NULL`); err != nil {
		t.Fatal(err)
	}
	if two, err := s.ClaimApps(ctx, 2, nil); err != nil || len(two) != 2 {
		t.Fatalf("limit 2: claimed %v, err %v", claimedIDs(two), err)
	}

	// An app with an intent but no runtime row gets one.
	addLifecycleApp(t, db, lifecycleApp{id: "no-runtime", desired: "stopped", generation: 1})
	if _, err := db.Exec(`DELETE FROM app_runtime WHERE app_id = 'no-runtime'`); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ClaimApps(ctx, 10, nil); err != nil || !slices.Contains(claimedIDs(got), "no-runtime") {
		t.Fatalf("no-runtime: claimed %v, err %v", claimedIDs(got), err)
	}
}

func TestReadIntent(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	addLifecycleApp(t, db, lifecycleApp{id: "plain", desired: "running", generation: 3, target: "plain-d", reconciled: 2},
		[2]string{"plain-d", "pending_deployment"})
	addLifecycleApp(t, db, lifecycleApp{id: "stopping", desired: "stopped", generation: 2, target: "stopping-d", reconciled: 1},
		[2]string{"stopping-d", "live"})
	addLifecycleApp(t, db, lifecycleApp{id: "building", desired: "running", generation: 2, target: "building-d", reconciled: 1},
		[2]string{"building-d", "scanning"})

	for _, want := range []struct {
		app, desired, target, status string
		needsWork                    bool
	}{
		{"plain", "running", "plain-d", "pending_deployment", true},
		{"stopping", "stopped", "stopping-d", "live", true},
		{"building", "running", "building-d", "scanning", false},
	} {
		in, err := s.ReadIntent(ctx, want.app)
		if err != nil || in == nil {
			t.Fatalf("%s: %v, err %v", want.app, in, err)
		}
		if in.Desired != want.desired || in.Target == nil || in.Target.ID != want.target ||
			in.TargetStatus != want.status || in.NeedsWork() != want.needsWork {
			t.Errorf("%s: desired %q, target %v (%s), needs work %v; want %q, %q (%s), %v",
				want.app, in.Desired, in.Target, in.TargetStatus, in.NeedsWork(),
				want.desired, want.target, want.status, want.needsWork)
		}
		if in.Target.AppSlug != want.app || in.Target.ProjectSlug != "p" || in.TargetErr != nil {
			t.Errorf("%s: target from snapshot %+v, err %v", want.app, in.Target, in.TargetErr)
		}
	}
	if in, err := s.ReadIntent(ctx, "deleted"); err != nil || in != nil {
		t.Errorf("deleted app: %+v, err %v; want nil", in, err)
	}
}

func TestFence(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "running", generation: 2, reconciled: 1, token: "mine"})
	lease := Lease{AppID: "app", Token: "mine"}

	ran := false
	step := func(context.Context) error { ran = true; return nil }
	if err := s.Fence(ctx, lease, 1, step); !errors.Is(err, ErrIntentChanged) || ran {
		t.Errorf("stale generation: err %v, ran %v; want ErrIntentChanged without running", err, ran)
	}
	if err := s.Fence(ctx, Lease{AppID: "app", Token: "theirs"}, 2, step); !errors.Is(err, ErrLeaseLost) || ran {
		t.Errorf("other lease: err %v, ran %v; want ErrLeaseLost without running", err, ran)
	}
	if err := s.Fence(ctx, Lease{AppID: "gone", Token: "mine"}, 2, step); !errors.Is(err, ErrIntentChanged) {
		t.Errorf("deleted app: err %v, want ErrIntentChanged", err)
	}
	if err := s.Fence(ctx, lease, 2, step); err != nil || !ran {
		t.Fatalf("current: err %v, ran %v", err, ran)
	}

	// An intent change made while the step runs waits for it, like the
	// API's FOR UPDATE does.
	inStep, release := make(chan struct{}), make(chan struct{})
	fenced := make(chan error, 1)
	go func() {
		fenced <- s.Fence(ctx, lease, 2, func(context.Context) error {
			close(inStep)
			<-release
			return nil
		})
	}()
	<-inStep
	updated := make(chan error, 1)
	go func() {
		_, err := db.Exec(`UPDATE app_intents SET generation = generation + 1 WHERE app_id = 'app'`)
		updated <- err
	}()
	select {
	case err := <-updated:
		t.Fatalf("intent changed during the step (err %v)", err)
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	if err := <-fenced; err != nil {
		t.Fatal(err)
	}
	if err := <-updated; err != nil {
		t.Fatal(err)
	}
	if err := s.Fence(ctx, lease, 2, step); !errors.Is(err, ErrIntentChanged) {
		t.Errorf("after the change: err %v, want ErrIntentChanged", err)
	}
}

// A fence whose transaction is lost after its step ran reports ErrFence, not
// the step's outcome: the change may have been made.
func TestFence_LostTransaction(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "running", generation: 1, token: "mine"})
	err := s.Fence(context.Background(), Lease{AppID: "app", Token: "mine"}, 1, func(context.Context) error {
		terminateFence(t, db)
		return nil // the change was made
	})
	if !errors.Is(err, ErrFence) {
		t.Errorf("err %v, want ErrFence", err)
	}
}

// terminateFence drops the connection of the fence transaction that is
// waiting in its step.
func terminateFence(t *testing.T, db *sql.DB) {
	t.Helper()
	var n int
	if err := db.QueryRow(`
		SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
		WHERE state = 'idle in transaction' AND query LIKE '%lease_token = $2 FOR SHARE%'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("terminated %d fence connections, err %v", n, err)
	}
}

// A stalled step is cut off after the fence timeout, which releases the lock.
func TestFence_Timeout(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "running", generation: 1, token: "mine"})
	defer func(d time.Duration) { fenceTimeout = d }(fenceTimeout)
	fenceTimeout = 200 * time.Millisecond

	err := s.Fence(context.Background(), Lease{AppID: "app", Token: "mine"}, 1, func(ctx context.Context) error {
		<-ctx.Done() // a Kubernetes call that never answers
		return ctx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err %v, want the step's deadline error", err)
	}
	if _, err := db.Exec(`UPDATE app_intents SET generation = generation + 1 WHERE app_id = 'app'`); err != nil {
		t.Errorf("intent still locked: %v", err)
	}
}

func TestHeartbeatAndRelease(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "stopped", generation: 1, token: "mine"})
	if err := s.Heartbeat(ctx, Lease{AppID: "app", Token: "mine"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Heartbeat(ctx, Lease{AppID: "app", Token: "theirs"}); !errors.Is(err, ErrLeaseLost) {
		t.Errorf("other lease: err %v, want ErrLeaseLost", err)
	}
	if err := s.Release(ctx, Lease{AppID: "app", Token: "mine"}); err != nil {
		t.Fatal(err)
	}
	if r := runtimeOf(t, db, "app"); r.token.Valid {
		t.Errorf("token %q after release", r.token.String)
	}
}

func TestFinishDeploy(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "running", generation: 3, target: "new", reconciled: 1, token: "mine"},
		[2]string{"old", "live"}, [2]string{"older", "live"}, [2]string{"new", "deploying"}, [2]string{"gone", "superseded"},
		[2]string{"stale", "deploying"}) // a rollout whose wait a restart cut off
	lease := Lease{AppID: "app", Token: "mine"}
	url := sql.NullString{String: "https://app-p.example.com", Valid: true}

	if err := s.FinishDeploy(ctx, Lease{AppID: "app", Token: "theirs"}, 3, "new", url); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("other lease: err %v, want ErrLeaseLost", err)
	}
	if statusOf(t, db, "new") != "deploying" || statusOf(t, db, "old") != "live" {
		t.Fatal("a refused FinishDeploy changed deployments")
	}
	if err := s.FinishDeploy(ctx, lease, 3, "gone", url); !errors.Is(err, ErrNotDeploying) {
		t.Fatalf("superseded attempt: err %v, want ErrNotDeploying", err)
	}

	if err := s.FinishDeploy(ctx, lease, 3, "new", url); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{"new": "live", "old": "superseded", "older": "superseded", "stale": "superseded"} {
		if got := statusOf(t, db, id); got != want {
			t.Errorf("%s: %s, want %s", id, got, want)
		}
	}
	if r := runtimeOf(t, db, "app"); r.reconciled != 3 || r.applied.String != "new" || r.liveURL != url {
		t.Errorf("runtime %+v", r)
	}
	// Recording an older generation never moves reconciled back.
	if err := s.FinishDeploy(ctx, lease, 2, "new", sql.NullString{}); err != nil {
		t.Fatal(err)
	}
	if r := runtimeOf(t, db, "app"); r.reconciled != 3 || r.liveURL.Valid {
		t.Errorf("after older generation: %+v", r)
	}
}

func TestFailDeploy(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "running", generation: 2, target: "d", reconciled: 1, token: "mine"},
		[2]string{"d", "deploying"})
	if err := s.FailDeploy(context.Background(), Lease{AppID: "app", Token: "mine"}, 2, "d", "rollout failed: boom"); err != nil {
		t.Fatal(err)
	}
	if status, msg, _ := deploymentState(t, db, "d"); status != "failed" || msg != "rollout failed: boom" {
		t.Errorf("d: %s %q", status, msg)
	}
	if r := runtimeOf(t, db, "app"); r.reconciled != 2 || r.lastError.String != "rollout failed: boom" {
		t.Errorf("runtime %+v", r)
	}
}

func TestFenceStop(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "stopped", generation: 4, target: "rolling", reconciled: 3, token: "mine"},
		[2]string{"live", "live"}, [2]string{"rolling", "deploying"},
		[2]string{"was-stopped", "stopped"}, [2]string{"marked", "failed"})
	// Stopped before its build was rolled out.
	addLifecycleApp(t, db, lifecycleApp{id: "built", desired: "stopped", generation: 2, target: "waiting", reconciled: 1, token: "mine"},
		[2]string{"waiting", "pending_deployment"})
	if _, err := db.Exec(`UPDATE deployments SET applied_manifest = 'm'`); err != nil {
		t.Fatal(err)
	}
	// A failed attempt a v1.5.0 API pod marked for teardown.
	if _, err := db.Exec(`UPDATE deployments SET teardown_requested_at = $1 WHERE id = 'marked'`, intentWritten); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE app_runtime SET applied_deployment_id = 'live', live_url = 'https://x' WHERE app_id = 'app'`); err != nil {
		t.Fatal(err)
	}

	tornDown := 0
	teardown := func(context.Context) error { tornDown++; return nil }
	for app, gen := range map[string]int64{"app": 4, "built": 2} {
		if err := s.FenceStop(context.Background(), Lease{AppID: app, Token: "mine"}, gen, teardown); err != nil {
			t.Fatal(err)
		}
	}
	if tornDown != 2 {
		t.Errorf("torn down %d times, want 2", tornDown)
	}
	for id, want := range map[string]string{
		"live": "stopped", "rolling": "stopped", "waiting": "superseded", "was-stopped": "stopped", "marked": "failed",
	} {
		if got := statusOf(t, db, id); got != want {
			t.Errorf("%s: %s, want %s", id, got, want)
		}
	}
	// No teardown markers are left for v1.5.0 to take for a Stop after a
	// rollback.
	_, _, manifest, requested := teardownState(t, db, "marked")
	if manifest != "m" || requested.Valid {
		t.Errorf("marked: manifest %q, teardown_requested_at %v; want the manifest kept, the marker cleared", manifest, requested)
	}
	for _, id := range []string{"live", "rolling", "was-stopped"} {
		if _, _, manifest, _ := teardownState(t, db, id); manifest != "" {
			t.Errorf("%s: manifest %q, want it cleared", id, manifest)
		}
	}
	if r := runtimeOf(t, db, "app"); r.reconciled != 4 || r.applied.Valid || r.liveURL.Valid {
		t.Errorf("runtime %+v", r)
	}
	in, err := s.ReadIntent(context.Background(), "app")
	if err != nil || in.NeedsWork() {
		t.Errorf("after FenceStop: needs work %v, err %v", in.NeedsWork(), err)
	}

	// A failed teardown records nothing.
	if _, err := db.Exec(`UPDATE app_intents SET generation = 5 WHERE app_id = 'app'`); err != nil {
		t.Fatal(err)
	}
	boom := errors.New("boom")
	if err := s.FenceStop(context.Background(), Lease{AppID: "app", Token: "mine"}, 5,
		func(context.Context) error { return boom }); !errors.Is(err, boom) {
		t.Errorf("err %v, want the teardown's", err)
	}
	if r := runtimeOf(t, db, "app"); r.reconciled != 4 {
		t.Errorf("reconciled %d after a failed teardown, want 4", r.reconciled)
	}
}

// A deploy accepted while a Stop is being torn down waits for the teardown
// and its record, so the record can't sweep the new attempt up with it.
func TestFenceStop_DeployDuringTeardownSurvives(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "stopped", generation: 2, target: "old", reconciled: 1, token: "mine"},
		[2]string{"old", "live"})

	deployed := make(chan error, 1)
	err := s.FenceStop(context.Background(), Lease{AppID: "app", Token: "mine"}, 2, func(context.Context) error {
		go func() {
			// What the API does for a deploy: lock the intent, add the
			// attempt, record it in the intent.
			tx, err := db.Begin()
			if err != nil {
				deployed <- err
				return
			}
			defer func() { _ = tx.Rollback() }()
			for _, q := range []string{
				`SELECT 1 FROM app_intents WHERE app_id = 'app' FOR UPDATE`,
				`INSERT INTO deployments (id, app_id, status, commit_sha, created_at, updated_at)
				 VALUES ('new', 'app', 'pending_deployment', 'abc', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
				`UPDATE app_intents SET generation = 3, desired_state = 'running', target_deployment_id = 'new',
				   updated_at = CURRENT_TIMESTAMP WHERE app_id = 'app'`,
			} {
				if _, err := tx.Exec(q); err != nil {
					deployed <- err
					return
				}
			}
			deployed <- tx.Commit()
		}()
		time.Sleep(300 * time.Millisecond) // the deploy is now waiting for the lock
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := <-deployed; err != nil {
		t.Fatal(err)
	}
	if got := statusOf(t, db, "new"); got != "pending_deployment" {
		t.Errorf("the new attempt is %s, want pending_deployment", got)
	}
	if got := statusOf(t, db, "old"); got != "stopped" {
		t.Errorf("old is %s, want stopped", got)
	}
	in, err := s.ReadIntent(context.Background(), "app")
	if err != nil || !in.NeedsWork() || in.Target.ID != "new" {
		t.Errorf("after the stop: %+v, err %v; want the new attempt still to roll out", in, err)
	}
}

func TestSweepSuperseded(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "running", desired: "running", generation: 2, target: "target"},
		[2]string{"target", "pending_deployment"}, [2]string{"done", "live"})
	// A build that finished after a newer deploy, whose own build failed.
	addLifecycleApp(t, db, lifecycleApp{id: "replaced", desired: "running", generation: 3, target: "newer"},
		[2]string{"older", "pending_deployment"}, [2]string{"newer", "failed"})
	addLifecycleApp(t, db, lifecycleApp{id: "stopped", desired: "stopped", generation: 2, target: "built-after-stop"},
		[2]string{"built-after-stop", "pending_deployment"})

	ids, err := s.SweepSuperseded(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(ids)
	if want := []string{"built-after-stop", "older"}; !slices.Equal(ids, want) {
		t.Errorf("superseded %v, want %v", ids, want)
	}
	for id, want := range map[string]string{"target": "pending_deployment", "done": "live"} {
		if got := statusOf(t, db, id); got != want {
			t.Errorf("%s: %s, want %s", id, got, want)
		}
	}
}

func TestStartDeploying(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "running", generation: 1, target: "d"},
		[2]string{"d", "pending_deployment"}, [2]string{"swept", "superseded"})
	if ok, err := s.StartDeploying(context.Background(), "d"); err != nil || !ok {
		t.Fatalf("pending: ok %v, err %v", ok, err)
	}
	if status, _, claimed := deploymentState(t, db, "d"); status != "deploying" || !claimed.Valid {
		t.Errorf("d: %s, claimed_at %v", status, claimed)
	}
	if ok, err := s.StartDeploying(context.Background(), "swept"); err != nil || ok {
		t.Errorf("superseded: ok %v, err %v; want false", ok, err)
	}
}

func TestReleaseAllLeases(t *testing.T) {
	s, db := testStore(t)
	fresh := time.Now()
	addLifecycleApp(t, db, lifecycleApp{id: "held", desired: "stopped", generation: 2, reconciled: 1, token: "dead", claimedAt: &fresh})
	if n, err := s.ReleaseAllLeases(context.Background()); err != nil || n != 1 {
		t.Fatalf("released %d, err %v", n, err)
	}
	if got, err := s.ClaimApps(context.Background(), 10, nil); err != nil || !slices.Equal(claimedIDs(got), []string{"held"}) {
		t.Errorf("claimed %v, err %v; want [held] at once", claimedIDs(got), err)
	}
	if err := s.Fence(context.Background(), Lease{AppID: "held", Token: "dead"}, 2, func(context.Context) error { return nil }); !errors.Is(err, ErrLeaseLost) {
		t.Errorf("old token: err %v, want ErrLeaseLost", err)
	}
}

func TestMarkReconciledRetiresStaleRollouts(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "app", desired: "running", generation: 3, target: "failed-build", reconciled: 2, token: "mine"},
		[2]string{"stale", "deploying"}, [2]string{"failed-build", "failed"}, [2]string{"serving", "live"})
	if err := s.MarkReconciled(context.Background(), Lease{AppID: "app", Token: "mine"}, 3, "failed-build"); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{"stale": "superseded", "failed-build": "failed", "serving": "live"} {
		if got := statusOf(t, db, id); got != want {
			t.Errorf("%s: %s, want %s", id, got, want)
		}
	}
	if r := runtimeOf(t, db, "app"); r.reconciled != 3 {
		t.Errorf("reconciled %d, want 3", r.reconciled)
	}
}
