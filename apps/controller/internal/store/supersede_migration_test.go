package store

import (
	"testing"
	"time"
)

const allowSupersedingMigration = "000029_deployments_allow_superseding"

// TestAllowSupersedingMigrationDown checks that rolling back 000029 keeps the
// attempt each app's intent targets, even when it isn't the newest, and fails
// the other attempts in progress so the one-in-progress index can return.
func TestAllowSupersedingMigrationDown(t *testing.T) {
	_, db := testStore(t)
	day := func(d int) time.Time { return time.Date(2026, 11, d, 12, 0, 0, 0, time.UTC) }
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO apps (id, project_id, name, slug, created_at, updated_at)
			VALUES ('targeted', 'p1', 't', 't', $1, $1), ('untargeted', 'p1', 'u', 'u', $1, $1)`, []any{day(1)}},
		// The target was created first but committed last.
		{`INSERT INTO deployments (id, app_id, status, commit_sha, created_at, updated_at) VALUES
			('target', 'targeted', 'pending_deployment', 'x', $1, $1),
			('newer', 'targeted', 'pending_deployment', 'x', $2, $2),
			('u-old', 'untargeted', 'building', 'x', $1, $1),
			('u-new', 'untargeted', 'building', 'x', $2, $2)`, []any{day(1), day(2)}},
		{`INSERT INTO app_intents (app_id, generation, desired_state, target_deployment_id, updated_at) VALUES
			('targeted', 3, 'running', 'target', $1), ('untargeted', 1, 'running', NULL, $1)`, []any{day(3)}},
	} {
		if _, err := db.Exec(q.sql, q.args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	applyMigrations(t, db, []string{"../../../api/migrations/" + allowSupersedingMigration + ".down.sql"})

	for id, want := range map[string]string{"target": "pending_deployment", "newer": "failed", "u-old": "failed", "u-new": "building"} {
		if got := statusOf(t, db, id); got != want {
			t.Errorf("%s: %s, want %s", id, got, want)
		}
	}
	if _, err := db.Exec(`INSERT INTO deployments (id, app_id, status, commit_sha, created_at, updated_at)
		VALUES ('second', 'targeted', 'building', 'x', $1, $1)`, day(4)); err == nil {
		t.Error("the one-in-progress index is not back")
	}
}
