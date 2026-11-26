package store

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

const appRuntimeMigration = "000028_app_runtime"

// TestAppRuntimeMigration checks that 000028 counts every app as reconciled
// up to its intent unless its latest deployment is still in progress, and
// carries over the serving deployment and the live URL.
func TestAppRuntimeMigration(t *testing.T) {
	db := testSchema(t)
	var before, rest []string
	for _, f := range migrationFiles(t, "up") {
		if filepath.Base(f) < appRuntimeMigration {
			before = append(before, f)
		} else {
			rest = append(rest, f)
		}
	}
	applyMigrations(t, db, before)
	seedProject(t, db) // a1 has no deployments and no intent

	day := func(d int) time.Time { return time.Date(2026, 11, d, 12, 0, 0, 0, time.UTC) }
	for _, stmt := range []struct {
		q    string
		args []any
	}{
		{`INSERT INTO apps (id, project_id, name, slug, live_url, created_at, updated_at)
			VALUES ('steady', 'p1', 's', 's', 'https://s-p.example.com', $1, $1),
			       ('rolling', 'p1', 'r', 'r', 'https://r-p.example.com', $1, $1),
			       ('building', 'p1', 'b', 'b', NULL, $1, $1)`, []any{day(1)}},
		{`INSERT INTO deployments (id, app_id, status, commit_sha, created_at, updated_at) VALUES
			('s-old', 'steady', 'live', 'x', $1, $1), ('s-new', 'steady', 'live', 'x', $2, $2),
			('r-live', 'rolling', 'live', 'x', $1, $1), ('r-new', 'rolling', 'deploying', 'x', $2, $2),
			('b-new', 'building', 'building', 'x', $2, $2)`, []any{day(1), day(2)}},
		{`INSERT INTO app_intents (app_id, generation, desired_state, target_deployment_id, updated_at) VALUES
			('steady', 4, 'running', 's-new', $1), ('rolling', 3, 'running', 'r-new', $1),
			('building', 2, 'running', 'b-new', $1)`, []any{day(2)}},
	} {
		if _, err := db.Exec(stmt.q, stmt.args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	applyMigrations(t, db, rest)

	for _, want := range []struct {
		app        string
		reconciled int64
		applied    string
		liveURL    string
	}{
		{"a1", 0, "", ""},
		{"steady", 4, "s-new", "https://s-p.example.com"},
		{"rolling", 0, "r-live", "https://r-p.example.com"},
		{"building", 0, "", ""},
	} {
		var reconciled int64
		var applied, liveURL sql.NullString
		if err := db.QueryRow(`SELECT reconciled_generation, applied_deployment_id, live_url FROM app_runtime WHERE app_id = $1`, want.app).
			Scan(&reconciled, &applied, &liveURL); err != nil {
			t.Fatalf("%s: %v", want.app, err)
		}
		if reconciled != want.reconciled || applied.String != want.applied || liveURL.String != want.liveURL {
			t.Errorf("%s: reconciled %d, applied %q, live URL %q; want %d, %q, %q",
				want.app, reconciled, applied.String, liveURL.String, want.reconciled, want.applied, want.liveURL)
		}
	}
}
