package persistence

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/testutil"
)

func TestPostgresRepositoryCreateAndGetRoundTrip(t *testing.T) {
	migrations := testutil.Migrations(t)
	for index, migration := range migrations {
		t.Run("schema_"+migration.Version, func(t *testing.T) {
			testRepositoryRoundTrip(t, migrations[:index+1])
		})
	}
}

func testRepositoryRoundTrip(t *testing.T, migrations []testutil.Migration) {
	t.Helper()
	db := testutil.OpenPostgres(t)
	testutil.ApplyMigrations(t, db, migrations)
	repo := NewPostgresRepository(db)
	ctx := context.Background()
	input := testCreateVideoInput(time.Date(2026, time.August, 25, 3, 0, 0, 0, time.UTC))

	created, err := repo.CreateVideo(ctx, input)
	if err != nil {
		t.Fatalf("CreateVideo() error = %v", err)
	}
	if created.VideoID != input.VideoID || created.Job.JobID != input.JobID {
		t.Fatalf("CreateVideo() ids = %#v", created)
	}
	if created.Job.Status != JobStatusUploading {
		t.Fatalf("CreateVideo() status = %q, want %q", created.Job.Status, JobStatusUploading)
	}
	if created.CreatedAt.IsZero() || created.Job.CreatedAt.IsZero() {
		t.Fatal("CreateVideo() did not return database timestamps")
	}

	got, err := repo.GetVideoByID(ctx, input.VideoID)
	if err != nil {
		t.Fatalf("GetVideoByID() error = %v", err)
	}
	if got.VideoID != input.VideoID || got.Job.JobID != input.JobID || got.Job.VideoID != input.VideoID {
		t.Fatalf("GetVideoByID() ids = %#v", got)
	}
	if got.FileName != input.FileName || got.ContentType != input.ContentType || got.SizeBytes != input.SizeBytes {
		t.Fatalf("GetVideoByID() file metadata = %#v", got)
	}
	if got.Upload.Bucket != input.Upload.Bucket || got.Upload.Key != input.Upload.Key {
		t.Fatalf("GetVideoByID() upload = %#v", got.Upload)
	}
	if got.Job.Status != JobStatusUploading || got.Job.Failure != nil {
		t.Fatalf("GetVideoByID() job = %#v", got.Job)
	}

	_, err = db.ExecContext(ctx, `
UPDATE jobs
SET status = $1, failure_code = $2, failure_message = $3
WHERE id = $4 AND video_id = $5`,
		JobStatusFailed, "ENCODING_FAILED", "The encoder rejected the source file.", input.JobID, input.VideoID)
	if err != nil {
		t.Fatalf("update failed job: %v", err)
	}

	failed, err := repo.GetVideoByID(ctx, input.VideoID)
	if err != nil {
		t.Fatalf("GetVideoByID() after failure error = %v", err)
	}
	if failed.Job.Status != JobStatusFailed {
		t.Fatalf("status = %q, want FAILED", failed.Job.Status)
	}
	if failed.Job.Failure == nil || failed.Job.Failure.Code != "ENCODING_FAILED" {
		t.Fatalf("failure = %#v", failed.Job.Failure)
	}

	_, err = repo.GetVideoByID(ctx, CanonicalUUID("33333333-3333-3333-3333-333333333333"))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing video error = %v, want ErrNotFound", err)
	}
}

func TestPhase1MigrationAppliesAndReverses(t *testing.T) {
	db, _ := setupIntegrationPostgres(t)

	if !relationExists(t, db, "videos") || !relationExists(t, db, "jobs") {
		t.Fatal("up migration did not create videos and jobs")
	}

	execSQL(t, db, readMigration(t, "0001_phase1_schema.down.sql"))
	if relationExists(t, db, "videos") || relationExists(t, db, "jobs") {
		t.Fatal("down migration left videos or jobs in place")
	}

	execSQL(t, db, readMigration(t, "0001_phase1_schema.up.sql"))
	if !relationExists(t, db, "videos") || !relationExists(t, db, "jobs") {
		t.Fatal("re-applied up migration did not recreate videos and jobs")
	}
}

func TestPhase1AppliedSchemaMatchesContract(t *testing.T) {
	db, _ := setupIntegrationPostgres(t)

	videos := tableColumns(t, db, "videos")
	for column, wantType := range map[string]string{
		"video_id":          "uuid",
		"file_name":         "text",
		"content_type":      "text",
		"size_bytes":        "bigint",
		"upload_bucket":     "text",
		"upload_key":        "text",
		"upload_expires_at": "timestamp with time zone",
		"created_at":        "timestamp with time zone",
		"updated_at":        "timestamp with time zone",
	} {
		if videos[column] != wantType {
			t.Fatalf("videos.%s type = %q, want %q", column, videos[column], wantType)
		}
	}

	jobs := tableColumns(t, db, "jobs")
	for column, wantType := range map[string]string{
		"id":              "uuid",
		"video_id":        "uuid",
		"status":          "text",
		"failure_code":    "text",
		"failure_message": "text",
		"created_at":      "timestamp with time zone",
		"updated_at":      "timestamp with time zone",
	} {
		if jobs[column] != wantType {
			t.Fatalf("jobs.%s type = %q, want %q", column, jobs[column], wantType)
		}
	}

	jobConstraints := strings.ToUpper(strings.Join(constraintDefs(t, db, "jobs"), "\n"))
	if !strings.Contains(jobConstraints, "REFERENCES") || !strings.Contains(jobConstraints, "VIDEOS") {
		t.Fatalf("jobs missing foreign key to videos: %s", jobConstraints)
	}
	if !strings.Contains(jobConstraints, "ON DELETE CASCADE") {
		t.Fatalf("jobs foreign key must cascade deletes: %s", jobConstraints)
	}
	if !strings.Contains(jobConstraints, "UNIQUE") {
		t.Fatalf("jobs.video_id must be unique: %s", jobConstraints)
	}
	for _, status := range contractJobStatuses(t) {
		if !strings.Contains(jobConstraints, "'"+strings.ToUpper(status)+"'") {
			t.Fatalf("jobs status check missing %q: %s", status, jobConstraints)
		}
	}
	if !strings.Contains(jobConstraints, "FAILURE_CODE") || !strings.Contains(jobConstraints, "FAILURE_MESSAGE") {
		t.Fatalf("jobs missing failure-details check: %s", jobConstraints)
	}

	var indexName string
	if err := db.QueryRow(`
SELECT indexname
FROM pg_indexes
WHERE schemaname = current_schema() AND tablename = 'jobs' AND indexname = 'jobs_status_idx'`).Scan(&indexName); err != nil {
		t.Fatalf("jobs_status_idx: %v", err)
	}
}

func TestPhase1SchemaRejectsInvalidRows(t *testing.T) {
	db, _ := setupIntegrationPostgres(t)

	if _, err := db.Exec(`
INSERT INTO videos (video_id, file_name, content_type, size_bytes, upload_bucket, upload_key, upload_expires_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'sample.mp4', 'video/mp4', 1, 'input-bucket',
        'videos/11111111-1111-1111-1111-111111111111/jobs/22222222-2222-2222-2222-222222222222/source.mp4', NOW())`); err != nil {
		t.Fatalf("insert valid video: %v", err)
	}
	if _, err := db.Exec(`
INSERT INTO jobs (id, video_id, status)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'UPLOADING')`); err != nil {
		t.Fatalf("insert valid job: %v", err)
	}
	if _, err := db.Exec(`
INSERT INTO videos (video_id, file_name, content_type, size_bytes, upload_bucket, upload_key, upload_expires_at)
VALUES ('33333333-3333-3333-3333-333333333333', 'other.mp4', 'video/mp4', 1, 'input-bucket',
        'videos/33333333-3333-3333-3333-333333333333/jobs/44444444-4444-4444-4444-444444444444/source.mp4', NOW())`); err != nil {
		t.Fatalf("insert second video: %v", err)
	}

	tests := map[string]string{
		"invalid content type": `INSERT INTO videos (video_id, file_name, content_type, size_bytes, upload_bucket, upload_key, upload_expires_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x.mp4', 'video/webm', 1, 'bucket', 'key', NOW())`,
		"non-positive size": `INSERT INTO videos (video_id, file_name, content_type, size_bytes, upload_bucket, upload_key, upload_expires_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x.mp4', 'video/mp4', 0, 'bucket', 'key', NOW())`,
		"invalid status": `INSERT INTO jobs (id, video_id, status)
VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'UNKNOWN')`,
		"failed without details":         `UPDATE jobs SET status = 'FAILED' WHERE id = '22222222-2222-2222-2222-222222222222'`,
		"uploading with failure details": `UPDATE jobs SET failure_code = 'X', failure_message = 'y' WHERE id = '22222222-2222-2222-2222-222222222222'`,
	}
	for name, stmt := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := db.Exec(stmt); err == nil {
				t.Fatalf("statement succeeded, want constraint error: %s", stmt)
			}
		})
	}
}

func setupIntegrationPostgres(t *testing.T) (*sql.DB, *PostgresRepository) {
	t.Helper()
	db := testutil.OpenPostgres(t)
	execSQL(t, db, readMigration(t, "0001_phase1_schema.up.sql"))
	return db, NewPostgresRepository(db)
}

func execSQL(t *testing.T, db *sql.DB, script string) {
	t.Helper()
	for _, stmt := range strings.Split(script, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("exec %q: %v", stmt, err)
		}
	}
}

func relationExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var reg *string
	if err := db.QueryRow("SELECT to_regclass($1)::text", name).Scan(&reg); err != nil {
		t.Fatalf("to_regclass(%s): %v", name, err)
	}
	return reg != nil
}

func tableColumns(t *testing.T, db *sql.DB, table string) map[string]string {
	t.Helper()
	rows, err := db.Query(`
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = $1`, table)
	if err != nil {
		t.Fatalf("columns for %s: %v", table, err)
	}
	defer rows.Close()

	got := map[string]string{}
	for rows.Next() {
		var name, dataType string
		if err := rows.Scan(&name, &dataType); err != nil {
			t.Fatalf("scan column: %v", err)
		}
		got[name] = dataType
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("columns for %s: %v", table, err)
	}
	return got
}

func constraintDefs(t *testing.T, db *sql.DB, table string) []string {
	t.Helper()
	rows, err := db.Query(`
SELECT pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class rel ON rel.oid = c.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = current_schema() AND rel.relname = $1`, table)
	if err != nil {
		t.Fatalf("constraints for %s: %v", table, err)
	}
	defer rows.Close()

	var defs []string
	for rows.Next() {
		var def string
		if err := rows.Scan(&def); err != nil {
			t.Fatalf("scan constraint: %v", err)
		}
		defs = append(defs, def)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("constraints for %s: %v", table, err)
	}
	return defs
}
