package store

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func TestClaimTeardown_FailedAttemptMarkedByStop(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	now := time.Now()
	insertDeployment(t, db, "stopped", "stopped", validSnapshot, nil, now.Add(-3*time.Second))
	insertDeployment(t, db, "marked", "failed", validSnapshot, nil, now.Add(-2*time.Second))
	insertDeployment(t, db, "unmarked", "failed", validSnapshot, nil, now.Add(-time.Second))
	insertDeployment(t, db, "no-manifest", "failed", validSnapshot, nil, now)
	if _, err := db.Exec(`UPDATE deployments SET applied_manifest = 'm' WHERE id IN ('stopped', 'marked', 'unmarked')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE deployments SET error_message = 'rollout failed', teardown_requested_at = $1
		WHERE id IN ('marked', 'no-manifest')`, now); err != nil {
		t.Fatal(err)
	}

	deps, err := s.ClaimTeardown(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(deps) != 2 || deps[0].ID != "stopped" || deps[1].ID != "marked" {
		t.Fatalf("claimed %+v, want [stopped marked]", deps)
	}
	if d := deps[1]; d.AppSlug != "a" || d.ProjectID != "p1" || d.ProjectSlug != "p" || d.DeploymentType != "web" {
		t.Errorf("marked: got %+v", d)
	}

	for _, id := range []string{"stopped", "marked"} {
		if err := s.MarkTornDown(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	if deps, err := s.ClaimTeardown(ctx, 10); err != nil || len(deps) != 0 {
		t.Fatalf("after MarkTornDown: claimed %+v, err %v", deps, err)
	}

	// The failed attempt keeps its history; only the marker is cleared.
	status, msg, manifest, requested := teardownState(t, db, "marked")
	if status != "failed" || msg != "rollout failed" || manifest != "m" || requested.Valid {
		t.Errorf("marked: status=%s error=%q manifest=%q teardown_requested_at=%v", status, msg, manifest, requested)
	}
	if _, _, manifest, _ := teardownState(t, db, "stopped"); manifest != "" {
		t.Errorf("stopped: manifest=%q, want it cleared", manifest)
	}
}

func teardownState(t *testing.T, db *sql.DB, id string) (status, errMsg, manifest string, requested sql.NullTime) {
	t.Helper()
	var msg, man sql.NullString
	if err := db.QueryRow(`SELECT status, error_message, applied_manifest, teardown_requested_at FROM deployments WHERE id = $1`, id).
		Scan(&status, &msg, &man, &requested); err != nil {
		t.Fatal(err)
	}
	return status, msg.String, man.String, requested
}
