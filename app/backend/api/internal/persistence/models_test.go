package persistence

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestJobStatusMappings(t *testing.T) {
	want := []JobStatus{
		"UPLOADING",
		"QUEUED",
		"PROCESSING",
		"COMPLETED",
		"FAILED",
	}

	if !reflect.DeepEqual(AllJobStatuses, want) {
		t.Fatalf("AllJobStatuses = %#v, want %#v", AllJobStatuses, want)
	}

	for _, status := range want {
		if !status.IsValid() {
			t.Fatalf("status %q should be valid", status)
		}
	}

	if JobStatus("UNKNOWN").IsValid() {
		t.Fatal("unknown status should be invalid")
	}
}

func TestPersistenceModelShape(t *testing.T) {
	videoType := reflect.TypeOf(Video{})

	wantFields := map[string]reflect.Type{
		"VideoID":     reflect.TypeOf(CanonicalUUID("")),
		"FileName":    reflect.TypeOf(""),
		"ContentType": reflect.TypeOf(""),
		"SizeBytes":   reflect.TypeOf(int64(0)),
		"Upload":      reflect.TypeOf(UploadMetadata{}),
		"Job":         reflect.TypeOf(EncodingJob{}),
		"CreatedAt":   reflect.TypeOf(time.Time{}),
		"UpdatedAt":   reflect.TypeOf(time.Time{}),
	}

	for name, wantType := range wantFields {
		field, ok := videoType.FieldByName(name)
		if !ok {
			t.Fatalf("Video is missing field %q", name)
		}
		if field.Type != wantType {
			t.Fatalf("Video.%s type = %v, want %v", name, field.Type, wantType)
		}
	}

	jobType := reflect.TypeOf(EncodingJob{})
	wantJobFields := map[string]reflect.Type{
		"JobID":     reflect.TypeOf(CanonicalUUID("")),
		"VideoID":   reflect.TypeOf(CanonicalUUID("")),
		"Status":    reflect.TypeOf(JobStatus("")),
		"Failure":   reflect.TypeOf((*JobFailure)(nil)),
		"CreatedAt": reflect.TypeOf(time.Time{}),
		"UpdatedAt": reflect.TypeOf(time.Time{}),
	}

	for name, wantType := range wantJobFields {
		field, ok := jobType.FieldByName(name)
		if !ok {
			t.Fatalf("EncodingJob is missing field %q", name)
		}
		if field.Type != wantType {
			t.Fatalf("EncodingJob.%s type = %v, want %v", name, field.Type, wantType)
		}
	}
}

func TestMigrationStructure(t *testing.T) {
	up := readMigration(t, "0001_phase1_schema.up.sql")
	down := readMigration(t, "0001_phase1_schema.down.sql")

	mustContainAll(t, up,
		"CREATE TABLE videos",
		"video_id uuid PRIMARY KEY",
		"upload_bucket text NOT NULL",
		"upload_key text NOT NULL",
		"upload_expires_at timestamptz NOT NULL",
		"CREATE TABLE encoding_jobs",
		"video_id uuid NOT NULL UNIQUE REFERENCES videos(video_id) ON DELETE CASCADE",
		"status text NOT NULL CHECK (status IN ('UPLOADING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'))",
		"CONSTRAINT encoding_jobs_failure_details_check CHECK (",
		"CREATE INDEX encoding_jobs_status_idx ON encoding_jobs (status)",
	)

	if strings.Count(up, "CREATE TABLE") != 2 {
		t.Fatalf("up migration should define exactly two tables, got %d", strings.Count(up, "CREATE TABLE"))
	}

	if idxJobs := strings.Index(down, "DROP TABLE IF EXISTS encoding_jobs"); idxJobs < 0 {
		t.Fatal("down migration must drop encoding_jobs")
	} else if idxVideos := strings.Index(down, "DROP TABLE IF EXISTS videos"); idxVideos < 0 {
		t.Fatal("down migration must drop videos")
	} else if idxJobs > idxVideos {
		t.Fatal("down migration must drop encoding_jobs before videos")
	}
}

func readMigration(t *testing.T, name string) string {
	t.Helper()

	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}

	path := filepath.Join(filepath.Dir(file), "migrations", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func mustContainAll(t *testing.T, haystack string, needles ...string) {
	t.Helper()

	for _, needle := range needles {
		if !strings.Contains(haystack, needle) {
			t.Fatalf("migration missing %q", needle)
		}
	}
}
