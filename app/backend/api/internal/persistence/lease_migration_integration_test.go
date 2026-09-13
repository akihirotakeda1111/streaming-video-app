package persistence

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestLeaseMigrationConstraintsAndRollback(t *testing.T) {
	db, repo := setupIntegrationPostgres(t)
	ctx := context.Background()
	input := testCreateVideoInput(time.Date(2026, time.August, 25, 3, 0, 0, 0, time.UTC))
	if _, err := repo.CreateVideo(ctx, input); err != nil {
		t.Fatal(err)
	}

	// Check the same constraints after initial application and after down -> up.
	for _, stage := range []string{"initial", "reapplied"} {
		execSQL(t, db, readMigration(t, "0002_job_lease_persistence.up.sql"))
		var attempt int
		var owner sql.NullString
		var expiry sql.NullTime
		if err := db.QueryRow("SELECT attempt, worker_id, lease_expires_at FROM jobs WHERE id = $1", input.JobID).
			Scan(&attempt, &owner, &expiry); err != nil {
			t.Fatal(err)
		}
		if attempt != 0 || owner.Valid || expiry.Valid {
			t.Fatalf("%s: unsafe lease defaults: %d, %v, %v", stage, attempt, owner, expiry)
		}
		if _, err := db.Exec(`UPDATE jobs SET status = 'PROCESSING', attempt = 2,
worker_id = 'worker-a', lease_expires_at = NOW() + interval '5 minutes' WHERE id = $1`, input.JobID); err != nil {
			t.Fatalf("%s: valid owned job rejected: %v", stage, err)
		}

		for _, tc := range []struct {
			name string
			set  string
		}{
			{"negative_attempt", "attempt = -1"},
			{"owner_without_expiry", "lease_expires_at = NULL"},
			{"expiry_without_owner", "worker_id = NULL"},
			{"completed_with_lease", "status = 'COMPLETED'"},
			{"failed_with_lease", "status = 'FAILED', failure_code = 'ENCODING_FAILED', failure_message = 'encoding failed'"},
		} {
			t.Run(stage+"/"+tc.name, func(t *testing.T) {
				// Roll back even if a broken constraint unexpectedly permits the update.
				tx, err := db.BeginTx(ctx, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback()
				_, err = tx.Exec("UPDATE jobs SET "+tc.set+" WHERE id = $1", input.JobID)
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
					t.Fatalf("expected CHECK violation, got %v", err)
				}
			})
		}

		if stage == "initial" {
			before, err := repo.GetVideoByID(ctx, input.VideoID)
			if err != nil {
				t.Fatal(err)
			}
			execSQL(t, db, readMigration(t, "0002_job_lease_persistence.down.sql"))
			columns := tableColumns(t, db, "jobs")
			for _, column := range []string{"worker_id", "lease_expires_at", "attempt"} {
				if _, exists := columns[column]; exists {
					t.Fatalf("down migration left jobs.%s in place", column)
				}
			}
			after, err := repo.GetVideoByID(ctx, input.VideoID)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("down migration changed existing video and job data: got %#v, want %#v", after, before)
			}
		}
	}
}
