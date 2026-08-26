package httpapi

import (
	"context"
	crypto_rand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

const defaultUploadTTL = 15 * time.Minute

// CreateVideoRequest carries the request-domain metadata required to create the upload state.
type CreateVideoRequest struct {
	FileName    string
	ContentType string
	SizeBytes   int64
}

// ValidationError reports a contract violation on a single request field.
type ValidationError struct {
	Field  string
	Reason string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Reason)
}

// VideoCreationService validates the request-domain payload and persists the initial state.
type VideoCreationService struct {
	repo           persistence.Repository
	uploadBucket   string
	uploadTTL      time.Duration
	now            func() time.Time
	newCanonicalID func() (persistence.CanonicalUUID, error)
}

// NewVideoCreationService builds the service boundary for the later upload handler.
func NewVideoCreationService(repo persistence.Repository, uploadBucket string) *VideoCreationService {
	return NewVideoCreationServiceWithDeps(repo, uploadBucket, defaultUploadTTL, time.Now, newCanonicalUUID)
}

// NewVideoCreationServiceWithDeps builds the service boundary with explicit dependencies for tests and wiring.
func NewVideoCreationServiceWithDeps(
	repo persistence.Repository,
	uploadBucket string,
	uploadTTL time.Duration,
	now func() time.Time,
	newCanonicalID func() (persistence.CanonicalUUID, error),
) *VideoCreationService {
	return &VideoCreationService{
		repo:           repo,
		uploadBucket:   uploadBucket,
		uploadTTL:      uploadTTL,
		now:            now,
		newCanonicalID: newCanonicalID,
	}
}

// CreateVideo validates the contract metadata, generates canonical IDs, and persists one video plus one UPLOADING job.
func (s *VideoCreationService) CreateVideo(ctx context.Context, req CreateVideoRequest) (persistence.Video, error) {
	if s == nil {
		return persistence.Video{}, errors.New("video creation service is nil")
	}
	if s.repo == nil {
		return persistence.Video{}, errors.New("video repository is required")
	}
	if s.uploadBucket == "" {
		return persistence.Video{}, errors.New("upload bucket is required")
	}
	if err := validateCreateVideoRequest(req); err != nil {
		return persistence.Video{}, err
	}

	nowFn := s.now
	if nowFn == nil {
		nowFn = time.Now
	}
	idFn := s.newCanonicalID
	if idFn == nil {
		idFn = newCanonicalUUID
	}
	ttl := s.uploadTTL
	if ttl <= 0 {
		ttl = defaultUploadTTL
	}

	videoID, err := idFn()
	if err != nil {
		return persistence.Video{}, fmt.Errorf("generate video id: %w", err)
	}
	jobID, err := idFn()
	if err != nil {
		return persistence.Video{}, fmt.Errorf("generate job id: %w", err)
	}

	uploadCreatedAt := nowFn().UTC()
	input := persistence.CreateVideoInput{
		VideoID:     videoID,
		JobID:       jobID,
		FileName:    req.FileName,
		ContentType: req.ContentType,
		SizeBytes:   req.SizeBytes,
		Upload: persistence.UploadMetadata{
			Bucket:    s.uploadBucket,
			Key:       buildUploadKey(videoID, jobID),
			ExpiresAt: uploadCreatedAt.Add(ttl),
		},
	}

	return s.repo.CreateVideo(ctx, input)
}

func validateCreateVideoRequest(req CreateVideoRequest) error {
	if req.ContentType != "video/mp4" {
		return &ValidationError{Field: "content_type", Reason: "must be video/mp4"}
	}
	if req.SizeBytes <= 0 {
		return &ValidationError{Field: "size_bytes", Reason: "must be greater than zero"}
	}
	return nil
}

func buildUploadKey(videoID, jobID persistence.CanonicalUUID) string {
	return fmt.Sprintf("videos/%s/jobs/%s/source.mp4", videoID, jobID)
}

func newCanonicalUUID() (persistence.CanonicalUUID, error) {
	var raw [16]byte
	if _, err := crypto_rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("read entropy: %w", err)
	}

	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80

	buf := make([]byte, 36)
	hex.Encode(buf[0:8], raw[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], raw[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], raw[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], raw[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], raw[10:16])

	return persistence.CanonicalUUID(buf), nil
}
