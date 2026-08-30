package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPostgresRepositoryCreateVideoCommitsBothRecords(t *testing.T) {
	createdAt := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	updatedAt := createdAt.Add(2 * time.Minute)
	input := testCreateVideoInput(createdAt)
	db := &fakeRepositoryDB{
		tx: &fakeRepositoryTx{
			rows: []fakeRow{
				{values: []any{createdAt, updatedAt}},
				{values: []any{createdAt.Add(1 * time.Second), updatedAt.Add(1 * time.Second)}},
			},
		},
	}

	repo := &PostgresRepository{db: db}

	got, err := repo.CreateVideo(context.Background(), input)
	if err != nil {
		t.Fatalf("CreateVideo() error = %v", err)
	}

	if !db.tx.commitCalled {
		t.Fatal("CreateVideo() did not commit")
	}
	if db.tx.rollbackCalled {
		t.Fatal("CreateVideo() rolled back after successful commit")
	}
	if len(db.tx.calls) != 2 {
		t.Fatalf("transaction call count = %d, want 2", len(db.tx.calls))
	}
	if !strings.Contains(db.tx.calls[0].SQL, "INSERT INTO videos") {
		t.Fatalf("first statement = %q, want video insert", db.tx.calls[0].SQL)
	}
	assertPlaceholders(t, db.tx.calls[0].SQL, 7)
	assertSQLArgs(t, db.tx.calls[0].Args,
		input.VideoID,
		input.FileName,
		input.ContentType,
		input.SizeBytes,
		input.Upload.Bucket,
		input.Upload.Key,
		input.Upload.ExpiresAt,
	)
	if !strings.Contains(db.tx.calls[1].SQL, "INSERT INTO jobs") {
		t.Fatalf("second statement = %q, want job insert", db.tx.calls[1].SQL)
	}
	assertPlaceholders(t, db.tx.calls[1].SQL, 3)
	assertSQLArgs(t, db.tx.calls[1].Args, input.JobID, input.VideoID, JobStatusUploading)

	if got.VideoID != input.VideoID {
		t.Fatalf("VideoID = %q, want canonical UUID", got.VideoID)
	}
	if got.Job.JobID != input.JobID {
		t.Fatalf("Job.JobID = %q, want canonical UUID", got.Job.JobID)
	}
	if got.Job.Status != JobStatusUploading {
		t.Fatalf("Job.Status = %q, want %q", got.Job.Status, JobStatusUploading)
	}
	if got.FileName != input.FileName || got.ContentType != input.ContentType || got.SizeBytes != input.SizeBytes {
		t.Fatalf("CreateVideo() returned wrong video metadata: %#v", got)
	}
	if got.Upload.Bucket != input.Upload.Bucket || got.Upload.Key != input.Upload.Key {
		t.Fatalf("CreateVideo() returned wrong upload metadata: %#v", got.Upload)
	}
	if !got.CreatedAt.Equal(createdAt) || !got.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("CreateVideo() timestamps = %v %v, want %v %v", got.CreatedAt, got.UpdatedAt, createdAt, updatedAt)
	}
	if !got.Job.CreatedAt.Equal(createdAt.Add(1*time.Second)) || !got.Job.UpdatedAt.Equal(updatedAt.Add(1*time.Second)) {
		t.Fatalf("CreateVideo() job timestamps = %v %v, want %v %v", got.Job.CreatedAt, got.Job.UpdatedAt, createdAt.Add(time.Second), updatedAt.Add(time.Second))
	}
}

func TestPostgresRepositoryCreateVideoBeginTxFailure(t *testing.T) {
	db := &fakeRepositoryDB{beginErr: errors.New("too many connections")}
	repo := &PostgresRepository{db: db}

	_, err := repo.CreateVideo(context.Background(), testCreateVideoInput(time.Unix(1, 0).UTC()))
	if err == nil {
		t.Fatal("CreateVideo() error = nil, want begin failure")
	}
	if !strings.Contains(err.Error(), "begin transaction") {
		t.Fatalf("CreateVideo() error = %q, want begin failure", err)
	}
}

func TestPostgresRepositoryCreateVideoRollsBackOnVideoInsertError(t *testing.T) {
	db := &fakeRepositoryDB{
		tx: &fakeRepositoryTx{
			rows: []fakeRow{
				{err: errors.New("video insert failed")},
				{values: []any{time.Unix(10, 0).UTC(), time.Unix(20, 0).UTC()}},
			},
		},
	}
	repo := &PostgresRepository{db: db}

	_, err := repo.CreateVideo(context.Background(), testCreateVideoInput(time.Unix(1, 0).UTC()))
	if err == nil {
		t.Fatal("CreateVideo() error = nil, want failure")
	}
	if !strings.Contains(err.Error(), "insert video") {
		t.Fatalf("CreateVideo() error = %q, want video insert failure", err)
	}
	if len(db.tx.calls) != 1 || !strings.Contains(db.tx.calls[0].SQL, "INSERT INTO videos") {
		t.Fatalf("calls = %#v, want only the video insert", db.tx.calls)
	}
	if !db.tx.rollbackCalled {
		t.Fatal("CreateVideo() did not roll back after insert failure")
	}
	if db.tx.commitCalled {
		t.Fatal("CreateVideo() committed after insert failure")
	}
}

func TestPostgresRepositoryCreateVideoRollsBackOnJobInsertError(t *testing.T) {
	input := testCreateVideoInput(time.Unix(1, 0).UTC())
	db := &fakeRepositoryDB{
		tx: &fakeRepositoryTx{
			rows: []fakeRow{
				{values: []any{time.Unix(10, 0).UTC(), time.Unix(20, 0).UTC()}},
				{err: errors.New("job insert failed")},
			},
		},
	}

	repo := &PostgresRepository{db: db}

	_, err := repo.CreateVideo(context.Background(), input)
	if err == nil {
		t.Fatal("CreateVideo() error = nil, want failure")
	}
	if !strings.Contains(err.Error(), "insert job") {
		t.Fatalf("CreateVideo() error = %q, want job insert failure", err)
	}
	assertSQLArgs(t, db.tx.calls[0].Args,
		input.VideoID,
		input.FileName,
		input.ContentType,
		input.SizeBytes,
		input.Upload.Bucket,
		input.Upload.Key,
		input.Upload.ExpiresAt,
	)
	assertSQLArgs(t, db.tx.calls[1].Args, input.JobID, input.VideoID, JobStatusUploading)
	if !db.tx.rollbackCalled {
		t.Fatal("CreateVideo() did not roll back after insert failure")
	}
	if db.tx.commitCalled {
		t.Fatal("CreateVideo() committed after insert failure")
	}
}

func TestPostgresRepositoryCreateVideoRollsBackOnCommitError(t *testing.T) {
	db := &fakeRepositoryDB{
		tx: &fakeRepositoryTx{
			rows: []fakeRow{
				{values: []any{time.Unix(10, 0).UTC(), time.Unix(20, 0).UTC()}},
				{values: []any{time.Unix(11, 0).UTC(), time.Unix(21, 0).UTC()}},
			},
			commitErr: errors.New("commit failed"),
		},
	}
	repo := &PostgresRepository{db: db}

	_, err := repo.CreateVideo(context.Background(), testCreateVideoInput(time.Unix(1, 0).UTC()))
	if err == nil {
		t.Fatal("CreateVideo() error = nil, want commit failure")
	}
	if !strings.Contains(err.Error(), "commit transaction") {
		t.Fatalf("CreateVideo() error = %q, want commit failure", err)
	}
	if !db.tx.commitCalled {
		t.Fatal("CreateVideo() did not attempt commit")
	}
	if !db.tx.rollbackCalled {
		t.Fatal("CreateVideo() did not roll back after commit failure")
	}
}

func TestPostgresRepositoryGetVideoReturnsAggregate(t *testing.T) {
	createdAt := time.Date(2026, time.February, 3, 4, 5, 6, 0, time.UTC)
	updatedAt := createdAt.Add(10 * time.Minute)
	jobCreatedAt := createdAt.Add(1 * time.Minute)
	jobUpdatedAt := createdAt.Add(2 * time.Minute)
	videoID := CanonicalUUID("11111111-1111-1111-1111-111111111111")
	db := &fakeRepositoryDB{
		row: fakeRow{
			values: []any{
				videoID,
				"sample.mp4",
				"video/mp4",
				int64(12345),
				"input-bucket",
				"uploads/sample.mp4",
				createdAt.Add(time.Hour),
				createdAt,
				updatedAt,
				CanonicalUUID("22222222-2222-2222-2222-222222222222"),
				JobStatusFailed,
				sql.NullString{String: "transcode_failed", Valid: true},
				sql.NullString{String: "worker timeout", Valid: true},
				jobCreatedAt,
				jobUpdatedAt,
			},
		},
	}

	repo := &PostgresRepository{db: db}

	got, err := repo.GetVideoByID(context.Background(), videoID)
	if err != nil {
		t.Fatalf("GetVideoByID() error = %v", err)
	}

	if !strings.Contains(db.query, "FROM videos v") || !strings.Contains(db.query, "JOIN jobs j ON j.video_id = v.video_id") {
		t.Fatalf("query = %q, want video/job aggregate", db.query)
	}
	assertPlaceholders(t, db.query, 1)
	assertSQLArgs(t, db.args, videoID)

	if got.VideoID != videoID {
		t.Fatalf("VideoID = %q, want canonical UUID", got.VideoID)
	}
	if got.Job.JobID != "22222222-2222-2222-2222-222222222222" {
		t.Fatalf("Job.JobID = %q, want canonical UUID", got.Job.JobID)
	}
	if got.Job.VideoID != videoID {
		t.Fatalf("Job.VideoID = %q, want %q", got.Job.VideoID, videoID)
	}
	if got.Job.Status != JobStatusFailed {
		t.Fatalf("Job.Status = %q, want %q", got.Job.Status, JobStatusFailed)
	}
	if got.Job.Failure == nil {
		t.Fatal("Job.Failure = nil, want failure details")
	}
	if got.Job.Failure.Code != "transcode_failed" || got.Job.Failure.Message != "worker timeout" {
		t.Fatalf("Job.Failure = %#v, want failure details", got.Job.Failure)
	}
	if got.Upload.Bucket != "input-bucket" || got.Upload.Key != "uploads/sample.mp4" {
		t.Fatalf("Upload = %#v, want bucket/key from aggregate", got.Upload)
	}
	if !got.CreatedAt.Equal(createdAt) || !got.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("Video timestamps = %v %v, want %v %v", got.CreatedAt, got.UpdatedAt, createdAt, updatedAt)
	}
	if !got.Job.CreatedAt.Equal(jobCreatedAt) || !got.Job.UpdatedAt.Equal(jobUpdatedAt) {
		t.Fatalf("Job timestamps = %v %v, want %v %v", got.Job.CreatedAt, got.Job.UpdatedAt, jobCreatedAt, jobUpdatedAt)
	}
}

func TestPostgresRepositoryGetVideoReturnsNotFound(t *testing.T) {
	videoID := CanonicalUUID("11111111-1111-1111-1111-111111111111")
	db := &fakeRepositoryDB{
		row: fakeRow{err: sql.ErrNoRows},
	}

	repo := &PostgresRepository{db: db}

	_, err := repo.GetVideoByID(context.Background(), videoID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetVideoByID() error = %v, want ErrNotFound", err)
	}
	assertSQLArgs(t, db.args, videoID)
}

func TestPostgresRepositoryGetVideoReadFailure(t *testing.T) {
	db := &fakeRepositoryDB{
		row: fakeRow{err: errors.New("connection reset")},
	}
	repo := &PostgresRepository{db: db}

	_, err := repo.GetVideoByID(context.Background(), CanonicalUUID("11111111-1111-1111-1111-111111111111"))
	if err == nil {
		t.Fatal("GetVideoByID() error = nil, want read failure")
	}
	if errors.Is(err, ErrNotFound) {
		t.Fatal("GetVideoByID() returned ErrNotFound, want storage failure")
	}
	if !strings.Contains(err.Error(), "read video") {
		t.Fatalf("GetVideoByID() error = %q, want read failure", err)
	}
}

func testCreateVideoInput(createdAt time.Time) CreateVideoInput {
	return CreateVideoInput{
		VideoID:     CanonicalUUID("11111111-1111-1111-1111-111111111111"),
		JobID:       CanonicalUUID("22222222-2222-2222-2222-222222222222"),
		FileName:    "sample.mp4",
		ContentType: "video/mp4",
		SizeBytes:   12345,
		Upload: UploadMetadata{
			Bucket:    "input-bucket",
			Key:       "videos/11111111-1111-1111-1111-111111111111/jobs/22222222-2222-2222-2222-222222222222/source.mp4",
			ExpiresAt: createdAt.Add(time.Hour),
		},
	}
}

func assertSQLArgs(t *testing.T, got []any, want ...any) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("SQL args len = %d, want %d\n got %#v\nwant %#v", len(got), len(want), got, want)
	}
	for i := range want {
		if !reflect.DeepEqual(got[i], want[i]) {
			t.Fatalf("SQL arg $%d = %#v (%T), want %#v (%T)", i+1, got[i], got[i], want[i], want[i])
		}
	}
}

func assertPlaceholders(t *testing.T, query string, n int) {
	t.Helper()
	for i := 1; i <= n; i++ {
		placeholder := fmt.Sprintf("$%d", i)
		if !strings.Contains(query, placeholder) {
			t.Fatalf("query missing %s: %s", placeholder, query)
		}
	}
	if strings.Contains(query, fmt.Sprintf("$%d", n+1)) {
		t.Fatalf("query has extra $%d: %s", n+1, query)
	}
}

type capturedQuery struct {
	SQL  string
	Args []any
}

type fakeRepositoryDB struct {
	beginErr error
	tx       *fakeRepositoryTx
	row      fakeRow
	query    string
	args     []any
}

func (db *fakeRepositoryDB) QueryRowContext(_ context.Context, query string, args ...any) rowScanner {
	db.query = query
	db.args = append([]any(nil), args...)
	return db.row
}

func (db *fakeRepositoryDB) BeginTx(context.Context, *sql.TxOptions) (repositoryTx, error) {
	if db.beginErr != nil {
		return nil, db.beginErr
	}
	return db.tx, nil
}

type fakeRepositoryTx struct {
	rows           []fakeRow
	calls          []capturedQuery
	commitErr      error
	commitCalled   bool
	rollbackCalled bool
}

func (tx *fakeRepositoryTx) QueryRowContext(_ context.Context, query string, args ...any) rowScanner {
	tx.calls = append(tx.calls, capturedQuery{SQL: query, Args: append([]any(nil), args...)})
	if len(tx.rows) == 0 {
		return fakeRow{err: fmt.Errorf("unexpected query %q", query)}
	}
	row := tx.rows[0]
	tx.rows = tx.rows[1:]
	return row
}

func (tx *fakeRepositoryTx) Commit() error {
	tx.commitCalled = true
	if tx.commitErr != nil {
		return tx.commitErr
	}
	return nil
}

func (tx *fakeRepositoryTx) Rollback() error {
	tx.rollbackCalled = true
	return nil
}

type fakeRow struct {
	values []any
	err    error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return fmt.Errorf("scan count = %d, want %d", len(dest), len(r.values))
	}
	for i := range dest {
		if err := assignValue(dest[i], r.values[i]); err != nil {
			return fmt.Errorf("scan field %d: %w", i, err)
		}
	}
	return nil
}

func assignValue(dest any, src any) error {
	dv := reflect.ValueOf(dest)
	if dv.Kind() != reflect.Ptr || dv.IsNil() {
		return fmt.Errorf("destination must be a non-nil pointer")
	}

	sv := reflect.ValueOf(src)
	if !sv.IsValid() {
		dv.Elem().Set(reflect.Zero(dv.Elem().Type()))
		return nil
	}

	if sv.Type().AssignableTo(dv.Elem().Type()) {
		dv.Elem().Set(sv)
		return nil
	}
	if sv.Type().ConvertibleTo(dv.Elem().Type()) {
		dv.Elem().Set(sv.Convert(dv.Elem().Type()))
		return nil
	}

	return fmt.Errorf("cannot assign %s to %s", sv.Type(), dv.Elem().Type())
}
