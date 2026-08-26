package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

var ErrNotFound = errors.New("persistence: not found")

type rowScanner interface {
	Scan(dest ...any) error
}

type repositoryTx interface {
	QueryRowContext(ctx context.Context, query string, args ...any) rowScanner
	Commit() error
	Rollback() error
}

type repositoryDB interface {
	QueryRowContext(ctx context.Context, query string, args ...any) rowScanner
	BeginTx(ctx context.Context, opts *sql.TxOptions) (repositoryTx, error)
}

// Repository exposes the Phase 1 API-owned persistence operations.
type Repository interface {
	CreateVideo(ctx context.Context, input CreateVideoInput) (Video, error)
	GetVideoByID(ctx context.Context, videoID CanonicalUUID) (Video, error)
}

// CreateVideoInput contains the data required to create one video and its initial UPLOADING job.
type CreateVideoInput struct {
	VideoID     CanonicalUUID
	JobID       CanonicalUUID
	FileName    string
	ContentType string
	SizeBytes   int64
	Upload      UploadMetadata
}

type PostgresRepository struct {
	db repositoryDB
}

type postgresDB struct {
	db *sql.DB
}

func (db *postgresDB) QueryRowContext(ctx context.Context, query string, args ...any) rowScanner {
	return db.db.QueryRowContext(ctx, query, args...)
}

func (db *postgresDB) BeginTx(ctx context.Context, opts *sql.TxOptions) (repositoryTx, error) {
	tx, err := db.db.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &postgresTx{tx: tx}, nil
}

type postgresTx struct {
	tx *sql.Tx
}

func (tx *postgresTx) QueryRowContext(ctx context.Context, query string, args ...any) rowScanner {
	return tx.tx.QueryRowContext(ctx, query, args...)
}

func (tx *postgresTx) Commit() error {
	return tx.tx.Commit()
}

func (tx *postgresTx) Rollback() error {
	return tx.tx.Rollback()
}

func NewPostgresRepository(db *sql.DB) *PostgresRepository {
	return &PostgresRepository{db: &postgresDB{db: db}}
}

func (r *PostgresRepository) CreateVideo(ctx context.Context, input CreateVideoInput) (video Video, err error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return Video{}, fmt.Errorf("begin transaction: %w", err)
	}

	committed := false
	defer func() {
		if err != nil || !committed {
			_ = tx.Rollback()
		}
	}()

	videoRow := tx.QueryRowContext(ctx, `
INSERT INTO videos (
    video_id,
    file_name,
    content_type,
    size_bytes,
    upload_bucket,
    upload_key,
    upload_expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING created_at, updated_at`,
		input.VideoID,
		input.FileName,
		input.ContentType,
		input.SizeBytes,
		input.Upload.Bucket,
		input.Upload.Key,
		input.Upload.ExpiresAt,
	)
	if err := videoRow.Scan(&video.CreatedAt, &video.UpdatedAt); err != nil {
		return Video{}, fmt.Errorf("insert video: %w", err)
	}

	jobRow := tx.QueryRowContext(ctx, `
INSERT INTO jobs (
    id,
    video_id,
    status
) VALUES ($1, $2, $3)
RETURNING created_at, updated_at`,
		input.JobID,
		input.VideoID,
		JobStatusUploading,
	)
	if err := jobRow.Scan(&video.Job.CreatedAt, &video.Job.UpdatedAt); err != nil {
		return Video{}, fmt.Errorf("insert job: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return Video{}, fmt.Errorf("commit transaction: %w", err)
	}
	committed = true

	video.VideoID = input.VideoID
	video.FileName = input.FileName
	video.ContentType = input.ContentType
	video.SizeBytes = input.SizeBytes
	video.Upload = input.Upload
	video.Job = EncodingJob{
		JobID:     input.JobID,
		VideoID:   input.VideoID,
		Status:    JobStatusUploading,
		CreatedAt: video.Job.CreatedAt,
		UpdatedAt: video.Job.UpdatedAt,
	}

	return video, nil
}

func (r *PostgresRepository) GetVideoByID(ctx context.Context, videoID CanonicalUUID) (Video, error) {
	const query = `
SELECT
    v.video_id,
    v.file_name,
    v.content_type,
    v.size_bytes,
    v.upload_bucket,
    v.upload_key,
    v.upload_expires_at,
    v.created_at,
    v.updated_at,
    j.id,
    j.status,
    j.failure_code,
    j.failure_message,
    j.created_at,
    j.updated_at
FROM videos v
JOIN jobs j ON j.video_id = v.video_id
WHERE v.video_id = $1`

	var video Video
	var failureCode sql.NullString
	var failureMessage sql.NullString

	err := r.db.QueryRowContext(ctx, query, videoID).Scan(
		&video.VideoID,
		&video.FileName,
		&video.ContentType,
		&video.SizeBytes,
		&video.Upload.Bucket,
		&video.Upload.Key,
		&video.Upload.ExpiresAt,
		&video.CreatedAt,
		&video.UpdatedAt,
		&video.Job.JobID,
		&video.Job.Status,
		&failureCode,
		&failureMessage,
		&video.Job.CreatedAt,
		&video.Job.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Video{}, ErrNotFound
		}
		return Video{}, fmt.Errorf("read video: %w", err)
	}

	video.Job.VideoID = video.VideoID
	if failureCode.Valid && failureMessage.Valid {
		video.Job.Failure = &JobFailure{
			Code:    failureCode.String,
			Message: failureMessage.String,
		}
	}

	return video, nil
}
