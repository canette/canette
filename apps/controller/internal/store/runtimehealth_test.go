package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

const runtimeHealthMigration = "000026_app_observed_runtime_health"

// TestRuntimeHealthMigration checks that 000026 carries existing verdicts
// from apps to app_observed_status, and that its down migration puts them back.
func TestRuntimeHealthMigration(t *testing.T) {
	db := testSchema(t)
	var before, rest []string
	for _, f := range migrationFiles(t, "up") {
		if filepath.Base(f) < runtimeHealthMigration {
			before = append(before, f)
		} else {
			rest = append(rest, f)
		}
	}
	applyMigrations(t, db, before)
	seedProject(t, db)

	confirmed := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	for _, stmt := range []string{
		// a1 (from seedProject) was never observed and keeps the defaults.
		`INSERT INTO apps (id, project_id, name, slug, created_at, updated_at, runtime_health, runtime_health_updated_at)
			VALUES ('healthy', 'p1', 'h', 'h', $1, $1, 'healthy', $1)`,
		`INSERT INTO apps (id, project_id, name, slug, created_at, updated_at, runtime_health, runtime_health_reason, runtime_health_updated_at)
			VALUES ('crashing', 'p1', 'c', 'c', $1, $1, 'unhealthy', 'CrashLoopBackOff', $1)`,
		// The status reader already created a row for this app.
		`INSERT INTO app_observed_status (app_id, kubernetes_status, kubernetes_status_observed_at)
			VALUES ('crashing', '{"workload":"present"}', $1)`,
	} {
		if _, err := db.Exec(stmt, confirmed); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	applyMigrations(t, db, rest)

	type verdict struct {
		health    string
		reason    sql.NullString
		updatedAt sql.NullTime
	}
	observed := func(appID string) (verdict, bool) {
		t.Helper()
		var v verdict
		err := db.QueryRow(`SELECT runtime_health, runtime_health_reason, runtime_health_updated_at
			FROM app_observed_status WHERE app_id = $1`, appID).Scan(&v.health, &v.reason, &v.updatedAt)
		if err == sql.ErrNoRows {
			return v, false
		}
		if err != nil {
			t.Fatal(err)
		}
		return v, true
	}

	if v, ok := observed("healthy"); !ok || v.health != "healthy" || v.reason.Valid || !v.updatedAt.Time.Equal(confirmed) {
		t.Errorf("healthy: %+v (row %v)", v, ok)
	}
	if v, ok := observed("crashing"); !ok || v.health != "unhealthy" || v.reason.String != "CrashLoopBackOff" || !v.updatedAt.Time.Equal(confirmed) {
		t.Errorf("crashing: %+v (row %v)", v, ok)
	}
	var k8s sql.NullString
	if err := db.QueryRow(`SELECT kubernetes_status FROM app_observed_status WHERE app_id = 'crashing'`).Scan(&k8s); err != nil || k8s.String != `{"workload":"present"}` {
		t.Errorf("crashing kubernetes_status = %v, err %v: the copy must keep the existing reading", k8s, err)
	}
	if v, ok := observed("a1"); ok {
		t.Errorf("never observed app got a row: %+v", v)
	}
	var left int
	if err := db.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'apps' AND column_name LIKE 'runtime_health%'`).Scan(&left); err != nil || left != 0 {
		t.Errorf("apps still has %d runtime_health columns, err %v", left, err)
	}

	// Down puts the verdicts back on apps.
	applyMigrations(t, db, []string{"../../../api/migrations/" + runtimeHealthMigration + ".down.sql"})
	for _, want := range []struct {
		id     string
		health string
		reason string
		dated  bool
	}{
		{"healthy", "healthy", "", true},
		{"crashing", "unhealthy", "CrashLoopBackOff", true},
		{"a1", "unknown", "", false},
	} {
		var v verdict
		if err := db.QueryRow(`SELECT runtime_health, runtime_health_reason, runtime_health_updated_at FROM apps WHERE id = $1`, want.id).
			Scan(&v.health, &v.reason, &v.updatedAt); err != nil {
			t.Fatal(err)
		}
		if v.health != want.health || v.reason.String != want.reason || v.updatedAt.Valid != want.dated ||
			(want.dated && !v.updatedAt.Time.Equal(confirmed)) {
			t.Errorf("after down, %s: %+v", want.id, v)
		}
	}
}

func TestUpdateRuntimeHealth(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	before := time.Now().Add(-time.Second)

	// The status reader created the row first: the verdict joins it.
	if err := s.UpdateKubernetesStatus(ctx, "a1", `{"workload":"present"}`); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateRuntimeHealth(ctx, "a1", "unhealthy", "CrashLoopBackOff"); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateRuntimeHealth(ctx, "a1", "healthy", ""); err != nil {
		t.Fatal(err)
	}
	var health string
	var reason, k8s sql.NullString
	var updatedAt sql.NullTime
	if err := db.QueryRow(`SELECT runtime_health, runtime_health_reason, runtime_health_updated_at, kubernetes_status
		FROM app_observed_status WHERE app_id = 'a1'`).Scan(&health, &reason, &updatedAt, &k8s); err != nil {
		t.Fatal(err)
	}
	if health != "healthy" || reason.Valid {
		t.Errorf("verdict = %q, reason %v, want healthy with no reason", health, reason)
	}
	if !updatedAt.Valid || updatedAt.Time.Before(before) {
		t.Errorf("runtime_health_updated_at = %v, want now", updatedAt)
	}
	if k8s.String != `{"workload":"present"}` {
		t.Errorf("kubernetes_status = %v, want it kept", k8s)
	}

	// A verdict creates the row when it comes first.
	if _, err := db.Exec(`DELETE FROM app_observed_status`); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateRuntimeHealth(ctx, "a1", "unhealthy", "OOMKilled"); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT runtime_health, runtime_health_reason FROM app_observed_status WHERE app_id = 'a1'`).
		Scan(&health, &reason); err != nil || health != "unhealthy" || reason.String != "OOMKilled" {
		t.Errorf("first write: %q %v, err %v", health, reason, err)
	}

	// An app deleted since it was read gets no row, and no FK error.
	if err := s.UpdateRuntimeHealth(ctx, "deleted-app", "healthy", ""); err != nil {
		t.Fatalf("deleted app: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM app_observed_status WHERE app_id = 'deleted-app'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("deleted app: %d rows, err %v", n, err)
	}
}
