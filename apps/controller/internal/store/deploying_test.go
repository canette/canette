package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"go.uber.org/zap"
)

// These tests need a real Postgres (the queries use FOR UPDATE SKIP LOCKED and
// = ANY, which have no fake). Set CANETTE_TEST_DATABASE_URL to run them, e.g.
//
//	docker run --rm -d -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55432:5432 postgres:16-alpine
//	CANETTE_TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/postgres go test ./internal/store/
//
// Each test gets its own schema with the API's migrations applied.
func testStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	base := os.Getenv("CANETTE_TEST_DATABASE_URL")
	if base == "" {
		t.Skip("CANETTE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()

	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("t_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		a, err := sql.Open("pgx", base)
		if err == nil {
			_, _ = a.Exec("DROP SCHEMA " + schema + " CASCADE")
			_ = a.Close()
		}
	})

	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Applied the way apps/api/src/db/migrations.ts does.
	files, err := filepath.Glob("../../../api/migrations/*.up.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations found: %v", err)
	}
	sort.Strings(files)
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, stmt := range strings.Split(string(b), ";") {
			if stmt = strings.TrimSpace(stmt); stmt == "" {
				continue
			}
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				t.Fatalf("%s: %v", filepath.Base(f), err)
			}
		}
	}

	now := time.Now().UTC()
	for _, stmt := range []string{
		`INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES ('u1', 'u', 'u@example.com', 'x', 'x')`,
		`INSERT INTO teams (id, name, owner_id, created_at, updated_at) VALUES ('t1', 't', 'u1', $1, $1)`,
		`INSERT INTO projects (id, team_id, name, slug, created_at, updated_at) VALUES ('p1', 't1', 'p', 'p', $1, $1)`,
		`INSERT INTO apps (id, project_id, name, slug, created_at, updated_at) VALUES ('a1', 'p1', 'a', 'a', $1, $1)`,
	} {
		args := []any{now}
		if !strings.Contains(stmt, "$1") {
			args = nil
		}
		if _, err := db.ExecContext(ctx, stmt, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	return New(db, zap.NewNop()), db
}

const validSnapshot = `{"app":{"id":"a1","slug":"a"},"project":{"id":"p1","slug":"p"}}`

func insertDeployment(t *testing.T, db *sql.DB, id, status, snapshot string, claimedAt *time.Time, updatedAt time.Time) {
	t.Helper()
	var snap any
	if snapshot != "" {
		snap = snapshot
	}
	_, err := db.Exec(`
		INSERT INTO deployments (id, app_id, status, commit_sha, image_digest, deployment_snapshot, claimed_at, created_at, updated_at)
		VALUES ($1, 'a1', $2, 'abc', 'sha256:abc', $3, $4, $5, $5)`,
		id, status, snap, claimedAt, updatedAt)
	if err != nil {
		t.Fatalf("insert deployment %s: %v", id, err)
	}
}

func deploymentState(t *testing.T, db *sql.DB, id string) (status, errMsg string, claimedAt sql.NullTime) {
	t.Helper()
	var msg sql.NullString
	if err := db.QueryRow(`SELECT status, error_message, claimed_at FROM deployments WHERE id = $1`, id).
		Scan(&status, &msg, &claimedAt); err != nil {
		t.Fatal(err)
	}
	return status, msg.String, claimedAt
}

func TestClaimDeploying_SetsHeartbeatAndRespectsLimit(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	old := time.Now().Add(-time.Hour)
	insertDeployment(t, db, "d1", "pending_deployment", validSnapshot, nil, old)
	insertDeployment(t, db, "d2", "pending_deployment", validSnapshot, nil, old.Add(time.Second))

	deps, err := s.ClaimDeploying(ctx, 0)
	if err != nil || len(deps) != 0 {
		t.Fatalf("limit 0: got %d rows, err %v", len(deps), err)
	}
	deps, err = s.ClaimDeploying(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(deps) != 1 || deps[0].ID != "d1" {
		t.Fatalf("expected only d1 to be claimed, got %+v", deps)
	}
	status, _, claimed := deploymentState(t, db, "d1")
	if status != "deploying" || !claimed.Valid || time.Since(claimed.Time) > time.Minute {
		t.Errorf("d1: status=%s claimed_at=%v, want deploying with a fresh heartbeat", status, claimed)
	}
	if status, _, _ := deploymentState(t, db, "d2"); status != "pending_deployment" {
		t.Errorf("d2: status=%s, want pending_deployment", status)
	}
}

func TestClaimDeploying_FailsInvalidSnapshot(t *testing.T) {
	s, db := testStore(t)
	now := time.Now()
	insertDeployment(t, db, "empty", "pending_deployment", "", nil, now)
	insertDeployment(t, db, "broken", "pending_deployment", "{not json", nil, now)
	insertDeployment(t, db, "ok", "pending_deployment", validSnapshot, nil, now)

	deps, err := s.ClaimDeploying(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(deps) != 1 || deps[0].ID != "ok" {
		t.Fatalf("expected only the valid deployment to be returned, got %+v", deps)
	}
	for _, id := range []string{"empty", "broken"} {
		status, msg, _ := deploymentState(t, db, id)
		if status != "failed" || msg == "" {
			t.Errorf("%s: status=%s error=%q, want failed with a message", id, status, msg)
		}
	}
}

func TestRecoverAbandonedDeploying(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	now := time.Now()
	expired := now.Add(-DeployingHeartbeatTTL - time.Minute)
	fresh := now.Add(-10 * time.Second)

	insertDeployment(t, db, "expired", "deploying", validSnapshot, &expired, expired)
	insertDeployment(t, db, "fresh", "deploying", validSnapshot, &fresh, expired)
	insertDeployment(t, db, "running-here", "deploying", validSnapshot, &expired, expired)
	insertDeployment(t, db, "legacy", "deploying", validSnapshot, nil, expired) // claimed before claimed_at existed
	insertDeployment(t, db, "live", "live", validSnapshot, &expired, expired)

	ids, err := s.RecoverAbandonedDeploying(ctx, []string{"running-here"})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(ids)
	if strings.Join(ids, ",") != "expired,legacy" {
		t.Fatalf("recovered %v, want [expired legacy]", ids)
	}
	for id, want := range map[string]string{
		"expired": "failed", "legacy": "failed",
		"fresh": "deploying", "running-here": "deploying", "live": "live",
	} {
		status, msg, _ := deploymentState(t, db, id)
		if status != want {
			t.Errorf("%s: status=%s, want %s", id, status, want)
		}
		if want == "failed" && msg != AbandonedDeployingMessage {
			t.Errorf("%s: error=%q, want %q", id, msg, AbandonedDeployingMessage)
		}
	}

	// A nil running list is valid (no reconciles in this process).
	if _, err := s.RecoverAbandonedDeploying(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := deploymentState(t, db, "running-here"); status != "failed" {
		t.Errorf("running-here after it stopped running: status=%s, want failed", status)
	}
}

func TestHeartbeat_KeepsRowFromRecovery(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	expired := time.Now().Add(-DeployingHeartbeatTTL - time.Minute)
	insertDeployment(t, db, "d1", "deploying", validSnapshot, &expired, expired)

	if err := s.Heartbeat(ctx, "d1"); err != nil {
		t.Fatal(err)
	}
	ids, err := s.RecoverAbandonedDeploying(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 0 {
		t.Fatalf("recovered %v after a heartbeat, want none", ids)
	}
}
