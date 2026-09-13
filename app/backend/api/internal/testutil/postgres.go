// Package testutil provides shared database fixtures for integration tests.
package testutil

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type Migration struct {
	Version string
	SQL     string
}

// Migrations returns all forward migrations in their numbered file order.
// Adding a migration automatically extends the compatibility test matrix.
func Migrations(t *testing.T) []Migration {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate migrations")
	}
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(file), "..", "persistence", "migrations", "*.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatal("no forward migrations found")
	}
	migrations := make([]Migration, 0, len(paths))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		migrations = append(migrations, Migration{
			Version: strings.SplitN(filepath.Base(path), "_", 2)[0], SQL: string(data),
		})
	}
	return migrations
}

func ApplyMigrations(t *testing.T, db *sql.DB, migrations []Migration) {
	t.Helper()
	for _, migration := range migrations {
		if _, err := db.Exec(migration.SQL); err != nil {
			t.Fatalf("apply migration %s: %v", migration.Version, err)
		}
	}
}

// OpenPostgres isolates each test in a schema and removes it on completion.
// TEST_DATABASE_URL is mandatory when set; otherwise unavailable local DBs skip.
func OpenPostgres(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	required := dsn != ""
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		dsn = "postgres://streaming_video:streaming_video_dev_password@localhost:5432/streaming_video?sslmode=disable"
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		if required {
			t.Fatalf("postgres is not available: %v", err)
		}
		t.Skipf("postgres is not available: %v", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	schema := fmt.Sprintf("integration_test_%d", time.Now().UnixNano())
	if _, err := db.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA IF EXISTS " + schema + " CASCADE") })
	if _, err := db.ExecContext(ctx, "SET search_path TO "+schema); err != nil {
		t.Fatal(err)
	}
	return db
}
