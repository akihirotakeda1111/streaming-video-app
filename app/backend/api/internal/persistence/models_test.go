package persistence

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestJobStatusMatchesContract(t *testing.T) {
	want := contractJobStatuses(t)
	got := make(map[JobStatus]struct{}, len(AllJobStatuses))
	for _, status := range AllJobStatuses {
		got[status] = struct{}{}
		if !status.IsValid() {
			t.Fatalf("status %q should be valid", status)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("AllJobStatuses = %v, contract enum = %v", AllJobStatuses, want)
	}
	for _, status := range want {
		if _, ok := got[JobStatus(status)]; !ok {
			t.Fatalf("AllJobStatuses missing contract status %q", status)
		}
		if !JobStatus(status).IsValid() {
			t.Fatalf("contract status %q should be valid", status)
		}
	}
	if JobStatus("UNKNOWN").IsValid() {
		t.Fatal("unknown status should be invalid")
	}
}

func TestDownMigrationDropsJobsBeforeVideos(t *testing.T) {
	down := readMigration(t, "0001_phase1_schema.down.sql")
	idxJobs := strings.Index(down, "DROP TABLE IF EXISTS jobs")
	idxVideos := strings.Index(down, "DROP TABLE IF EXISTS videos")
	if idxJobs < 0 || idxVideos < 0 {
		t.Fatal("down migration must drop jobs and videos")
	}
	if idxJobs > idxVideos {
		t.Fatal("down migration must drop jobs before videos")
	}
}

func contractJobStatuses(t *testing.T) []string {
	t.Helper()

	var schema struct {
		Enum []string `json:"enum"`
	}
	if err := json.Unmarshal(readSharedContract(t, "domain", "job-status.schema.json"), &schema); err != nil {
		t.Fatalf("parse job-status contract: %v", err)
	}
	if len(schema.Enum) == 0 {
		t.Fatal("job-status contract enum is empty")
	}
	return schema.Enum
}

func readSharedContract(t *testing.T, rel ...string) []byte {
	t.Helper()

	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	parts := append([]string{filepath.Dir(file), "..", "..", "..", "..", "contracts"}, rel...)
	path := filepath.Join(parts...)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
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
