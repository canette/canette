package store

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

const appIntentsMigration = "000027_app_intents"

// TestAppIntentsMigration checks that 000027 gives every app an intent from
// its latest deployment, that it allows the superseded status, and that its
// down migration undoes both.
func TestAppIntentsMigration(t *testing.T) {
	db := testSchema(t)
	var before, rest []string
	for _, f := range migrationFiles(t, "up") {
		if filepath.Base(f) < appIntentsMigration {
			before = append(before, f)
		} else {
			rest = append(rest, f)
		}
	}
	applyMigrations(t, db, before)
	seedProject(t, db) // a1 has no deployments

	day := func(d int) time.Time { return time.Date(2026, 11, d, 12, 0, 0, 0, time.UTC) }
	deps := []struct {
		id, app, status string
		created         time.Time
	}{
		{"run-old", "running", "failed", day(1)},
		{"run-live", "running", "live", day(2)},
		{"stop-live", "stopped", "stopped", day(2)},
		{"stop-old", "stopped", "live", day(1)}, // older live rows don't make it running
		{"fail-live", "failed", "live", day(1)},
		{"fail-new", "failed", "failed", day(2)},
		{"build", "building", "building", day(1)},
	}
	for _, app := range []string{"running", "stopped", "failed", "building"} {
		if _, err := db.Exec(`INSERT INTO apps (id, project_id, name, slug, created_at, updated_at)
			VALUES ($1, 'p1', $1, $1, $2, $2)`, app, day(1)); err != nil {
			t.Fatalf("seed app: %v", err)
		}
	}
	for _, d := range deps {
		if _, err := db.Exec(`INSERT INTO deployments (id, app_id, status, commit_sha, created_at, updated_at)
			VALUES ($1, $2, $3, 'abc', $4, $4)`, d.id, d.app, d.status, d.created); err != nil {
			t.Fatalf("seed deployment: %v", err)
		}
	}

	applyMigrations(t, db, rest)

	for _, want := range []struct {
		app, desired, target string
		generation           int64
	}{
		{"a1", "stopped", "", 0},
		{"running", "running", "run-live", 1},
		{"stopped", "stopped", "stop-live", 1},
		{"failed", "running", "fail-new", 1},
		{"building", "running", "build", 1},
	} {
		var desired string
		var target sql.NullString
		var generation int64
		if err := db.QueryRow(`SELECT desired_state, target_deployment_id, generation FROM app_intents WHERE app_id = $1`, want.app).
			Scan(&desired, &target, &generation); err != nil {
			t.Fatalf("%s: %v", want.app, err)
		}
		if desired != want.desired || target.String != want.target || generation != want.generation {
			t.Errorf("%s: desired %q, target %q, generation %d; want %q, %q, %d",
				want.app, desired, target.String, generation, want.desired, want.target, want.generation)
		}
	}

	if _, err := db.Exec(`INSERT INTO deployments (id, app_id, status, commit_sha, created_at, updated_at)
		VALUES ('sup', 'running', 'superseded', 'abc', $1, $1)`, day(3)); err != nil {
		t.Fatalf("superseded is rejected: %v", err)
	}

	// Down drops the intents and turns superseded rows into failed ones, so
	// the old CHECK can be restored.
	applyMigrations(t, db, []string{"../../../api/migrations/" + appIntentsMigration + ".down.sql"})
	var status string
	if err := db.QueryRow(`SELECT status FROM deployments WHERE id = 'sup'`).Scan(&status); err != nil || status != "failed" {
		t.Errorf("after down, superseded row is %q, err %v; want failed", status, err)
	}
	if _, err := db.Exec(`INSERT INTO deployments (id, app_id, status, commit_sha, created_at, updated_at)
		VALUES ('sup2', 'running', 'superseded', 'abc', $1, $1)`, day(3)); err == nil {
		t.Error("after down, superseded is still allowed")
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'app_intents'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("after down, app_intents exists (%d), err %v", n, err)
	}
}
