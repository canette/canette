package store

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func TestGetCurrentDeployments(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "running", desired: "running", generation: 2, target: "rolling"},
		[2]string{"serving", "live"}, [2]string{"rolling", "deploying"})
	addLifecycleApp(t, db, lifecycleApp{id: "stopping", desired: "stopped", generation: 2},
		[2]string{"stopping-d", "live"})
	addLifecycleApp(t, db, lifecycleApp{id: "never", desired: "running", generation: 1})
	if _, err := db.Exec(`UPDATE app_runtime SET applied_deployment_id = CASE app_id
		WHEN 'running' THEN 'serving' WHEN 'stopping' THEN 'stopping-d' END`); err != nil {
		t.Fatal(err)
	}

	deps, err := s.GetCurrentDeployments(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The applied deployment, not the rollout in progress, and nothing for an
	// app that is being stopped.
	if len(deps) != 1 {
		t.Fatalf("got %+v, want only the running app", deps)
	}
	if d := deps[0]; d.DeploymentID != "serving" || d.AppID != "running" || d.ProjectID != "p1" || d.ProjectSlug != "p" || d.AppSlug != "running" {
		t.Errorf("got %+v", d)
	}
}

// The workload type comes from the applied deployment's snapshot: an app
// edited to another type keeps running its old workload until it is redeployed.
func TestGetCurrentDeploymentsAppliedType(t *testing.T) {
	s, db := testStore(t)
	addLifecycleApp(t, db, lifecycleApp{id: "edited", desired: "running", generation: 1, target: "old"},
		[2]string{"old", "live"})
	snapshot := `{"app":{"id":"edited","slug":"edited","deployment_type":"web"},"project":{"id":"p1","slug":"p"}}`
	if _, err := db.Exec(`UPDATE deployments SET deployment_snapshot = $1 WHERE id = 'old'`, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE apps SET deployment_type = 'cronjob' WHERE id = 'edited'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE app_runtime SET applied_deployment_id = 'old' WHERE app_id = 'edited'`); err != nil {
		t.Fatal(err)
	}

	deps, err := s.GetCurrentDeployments(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(deps) != 1 || deps[0].DeploymentType != "web" {
		t.Fatalf("got %+v, want the applied deployment's type web", deps)
	}
}

func TestUpdateKubernetesStatus(t *testing.T) {
	s, db := testStore(t)
	before := time.Now().Add(-time.Second)
	status := `{"workload":"present","replicas":{"desired":3,"ready":1,"available":1,"updated":3}}`

	ctx := context.Background()

	// First write creates the row, the second updates it in place.
	if err := s.UpdateKubernetesStatus(ctx, "a1", `{"workload":"missing"}`); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateKubernetesStatus(ctx, "a1", status); err != nil {
		t.Fatal(err)
	}
	var got sql.NullString
	var observedAt sql.NullTime
	if err := db.QueryRow(`SELECT kubernetes_status, kubernetes_status_observed_at FROM app_observed_status WHERE app_id = 'a1'`).
		Scan(&got, &observedAt); err != nil {
		t.Fatal(err)
	}
	if got.String != status {
		t.Errorf("kubernetes_status = %q, want %q", got.String, status)
	}
	if !observedAt.Valid || observedAt.Time.Before(before) {
		t.Errorf("kubernetes_status_observed_at = %v, want now", observedAt)
	}

	// Deleting the app removes its observed row.
	if _, err := db.Exec(`DELETE FROM apps WHERE id = 'a1'`); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := db.QueryRow(`SELECT count(*) FROM app_observed_status WHERE app_id = 'a1'`).Scan(&left); err != nil || left != 0 {
		t.Errorf("after app delete: %d rows, err %v", left, err)
	}

	// An app deleted since it was read gets no row, and no FK error.
	if err := s.UpdateKubernetesStatus(ctx, "deleted-app", status); err != nil {
		t.Fatalf("deleted app: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM app_observed_status WHERE app_id = 'deleted-app'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("deleted app: %d rows, err %v", n, err)
	}
}
