package store

import (
	"database/sql"
	"testing"
)

const dropTransitionMigration = "000031_drop_transition_columns"

// TestDropTransitionColumnsMigration checks that 000031 drops the columns the
// old Stop wrote, and that its down migration restores apps.live_url from
// app_runtime.
func TestDropTransitionColumnsMigration(t *testing.T) {
	_, db := testStore(t)
	column := func(table, name string) bool {
		t.Helper()
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, table, name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}
	if column("apps", "live_url") || column("deployments", "teardown_requested_at") {
		t.Fatal("the transition columns are still there after 000031")
	}

	if _, err := db.Exec(`INSERT INTO app_runtime (app_id, live_url) VALUES ('a1', 'https://a-p.example.com')`); err != nil {
		t.Fatal(err)
	}
	applyMigrations(t, db, []string{"../../../api/migrations/" + dropTransitionMigration + ".down.sql"})
	var url sql.NullString
	if err := db.QueryRow(`SELECT live_url FROM apps WHERE id = 'a1'`).Scan(&url); err != nil || url.String != "https://a-p.example.com" {
		t.Errorf("after down, apps.live_url = %v, err %v", url, err)
	}
	if !column("deployments", "teardown_requested_at") {
		t.Error("after down, deployments.teardown_requested_at is missing")
	}
}
