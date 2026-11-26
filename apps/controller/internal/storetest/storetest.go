// Package storetest gives tests a Postgres database with the API's migrations
// applied, for the store and the controller. It doesn't import the store
// package, so the store's own tests can use it.
package storetest

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the pgx driver
)

// These tests need a real Postgres (the queries use FOR UPDATE SKIP LOCKED and
// = ANY, which have no fake). Set CANETTE_TEST_DATABASE_URL to run them, e.g.
//
//	docker run --rm -d -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55432:5432 postgres:16-alpine
//	CANETTE_TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/postgres go test ./...
//
// Each test gets its own schema. Without the variable, the test is skipped.

// DB returns a new schema with every migration applied and SeedProject's rows.
func DB(t *testing.T) *sql.DB {
	t.Helper()
	db := Schema(t)
	ApplyMigrations(t, db, MigrationFiles(t, "up"))
	SeedProject(t, db)
	return db
}

// Schema returns a connection to a new, empty schema that is dropped
// when the test ends.
func Schema(t *testing.T) *sql.DB {
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
	return db
}

// MigrationsDir is apps/api/migrations.
func MigrationsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "../../../api/migrations")
}

// MigrationFiles lists the API's migrations in order, direction "up" or "down".
func MigrationFiles(t *testing.T, direction string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(MigrationsDir(), "*."+direction+".sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations found: %v", err)
	}
	sort.Strings(files)
	return files
}

// ApplyMigrations runs files the way apps/api/src/db/migrations.ts does.
func ApplyMigrations(t *testing.T, db *sql.DB, files []string) {
	t.Helper()
	ctx := context.Background()
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
}

// SeedProject inserts user u1, team t1, project p1 and app a1.
func SeedProject(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
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
}
