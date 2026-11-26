package store

import (
	"database/sql"
	"testing"

	"go.uber.org/zap"

	"canette.dev/controller/internal/storetest"
)

// testStore returns a store on a new schema with every migration applied and
// storetest.SeedProject's rows (see storetest for how to run these tests).
func testStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	db := storetest.DB(t)
	return New(db, zap.NewNop()), db
}

func testSchema(t *testing.T) *sql.DB { return storetest.Schema(t) }

func migrationFiles(t *testing.T, direction string) []string {
	return storetest.MigrationFiles(t, direction)
}

func applyMigrations(t *testing.T, db *sql.DB, files []string) {
	storetest.ApplyMigrations(t, db, files)
}

func seedProject(t *testing.T, db *sql.DB) { storetest.SeedProject(t, db) }

func deploymentState(t *testing.T, db *sql.DB, id string) (status, errMsg string, claimedAt sql.NullTime) {
	t.Helper()
	var msg sql.NullString
	if err := db.QueryRow(`SELECT status, error_message, claimed_at FROM deployments WHERE id = $1`, id).
		Scan(&status, &msg, &claimedAt); err != nil {
		t.Fatal(err)
	}
	return status, msg.String, claimedAt
}

func teardownState(t *testing.T, db *sql.DB, id string) (status, errMsg, manifest string) {
	t.Helper()
	var msg, man sql.NullString
	if err := db.QueryRow(`SELECT status, error_message, applied_manifest FROM deployments WHERE id = $1`, id).
		Scan(&status, &msg, &man); err != nil {
		t.Fatal(err)
	}
	return status, msg.String, man.String
}
