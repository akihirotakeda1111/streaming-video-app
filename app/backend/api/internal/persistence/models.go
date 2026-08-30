package persistence

import "time"

// CanonicalUUID is the lowercase UUID form used by the API and persistence layer.
type CanonicalUUID string

// JobStatus is the fixed Phase 1 encoding-job lifecycle state.
type JobStatus string

const (
	JobStatusUploading  JobStatus = "UPLOADING"
	JobStatusQueued     JobStatus = "QUEUED"
	JobStatusProcessing JobStatus = "PROCESSING"
	JobStatusCompleted  JobStatus = "COMPLETED"
	JobStatusFailed     JobStatus = "FAILED"
)

var AllJobStatuses = []JobStatus{
	JobStatusUploading,
	JobStatusQueued,
	JobStatusProcessing,
	JobStatusCompleted,
	JobStatusFailed,
}

// IsValid reports whether the status is one of the contract values.
func (s JobStatus) IsValid() bool {
	switch s {
	case JobStatusUploading, JobStatusQueued, JobStatusProcessing, JobStatusCompleted, JobStatusFailed:
		return true
	default:
		return false
	}
}

// JobFailure stores the optional failure details for a failed encoding job.
type JobFailure struct {
	Code    string
	Message string
}

// UploadMetadata stores the S3 object metadata required to service the upload flow.
type UploadMetadata struct {
	Bucket    string
	Key       string
	ExpiresAt time.Time
}

// EncodingJob is the persistence model for the single Phase 1 job attached to a video.
type EncodingJob struct {
	JobID     CanonicalUUID
	VideoID   CanonicalUUID
	Status    JobStatus
	Failure   *JobFailure
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Video is the persistence model for a single uploaded Phase 1 video.
type Video struct {
	VideoID      CanonicalUUID
	FileName     string
	ContentType  string
	SizeBytes    int64
	Upload       UploadMetadata
	Job          EncodingJob
	CreatedAt    time.Time
	UpdatedAt    time.Time
}
