package httpapi

import (
	"context"
	crypto_rand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

const (
	defaultUploadTTL  = 15 * time.Minute
	maxFileNameLength = 255
	maxSizeBytes      = 5368709120 // 5 GiB
)

type CreateVideoRequest struct {
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	SizeBytes   int64  `json:"sizeBytes"`
}

type ValidationError struct{ Field, Reason string }

func (e *ValidationError) Error() string { return fmt.Sprintf("%s: %s", e.Field, e.Reason) }

type CreateVideoResult struct {
	Video  persistence.Video
	Upload PresignedUpload
}

// VideoCreationService implements the validate -> presign -> persist orchestration.
type VideoCreationService struct {
	repo           persistence.Repository
	presigner      UploadPresigner
	uploadBucket   string
	uploadTTL      time.Duration
	now            func() time.Time
	newCanonicalID func() (persistence.CanonicalUUID, error)
}

func NewVideoCreationService(repo persistence.Repository, presigner UploadPresigner, uploadBucket string) *VideoCreationService {
	return NewVideoCreationServiceWithDeps(repo, presigner, uploadBucket, defaultUploadTTL, time.Now, newCanonicalUUID)
}

func NewVideoCreationServiceWithDeps(repo persistence.Repository, presigner UploadPresigner, uploadBucket string, uploadTTL time.Duration, now func() time.Time, newCanonicalID func() (persistence.CanonicalUUID, error)) *VideoCreationService {
	return &VideoCreationService{repo: repo, presigner: presigner, uploadBucket: uploadBucket, uploadTTL: uploadTTL, now: now, newCanonicalID: newCanonicalID}
}

func (s *VideoCreationService) CreateVideo(ctx context.Context, req CreateVideoRequest) (CreateVideoResult, error) {
	if s == nil || s.repo == nil || s.presigner == nil || s.uploadBucket == "" {
		return CreateVideoResult{}, errors.New("video creation dependencies are required")
	}
	if err := validateCreateVideoRequest(req); err != nil {
		return CreateVideoResult{}, err
	}
	nowFn, idFn, ttl := s.now, s.newCanonicalID, s.uploadTTL
	if nowFn == nil {
		nowFn = time.Now
	}
	if idFn == nil {
		idFn = newCanonicalUUID
	}
	if ttl <= 0 {
		ttl = defaultUploadTTL
	}

	videoID, err := idFn()
	if err != nil {
		return CreateVideoResult{}, fmt.Errorf("generate video id: %w", err)
	}
	jobID, err := idFn()
	if err != nil {
		return CreateVideoResult{}, fmt.Errorf("generate job id: %w", err)
	}
	createdAt := nowFn().UTC()
	upload := persistence.UploadMetadata{Bucket: s.uploadBucket, Key: buildUploadKey(videoID, jobID), ExpiresAt: createdAt.Add(ttl)}
	presigned, err := s.presigner.PresignUpload(ctx, upload.Bucket, upload.Key, req.ContentType, ttl)
	if err != nil {
		return CreateVideoResult{}, fmt.Errorf("presign upload: %w", err)
	}
	video, err := s.repo.CreateVideo(ctx, persistence.CreateVideoInput{VideoID: videoID, JobID: jobID, FileName: req.FileName, ContentType: req.ContentType, SizeBytes: req.SizeBytes, Upload: upload})
	if err != nil {
		return CreateVideoResult{}, fmt.Errorf("persist video: %w", err)
	}
	return CreateVideoResult{Video: video, Upload: presigned}, nil
}

type createVideoResponse struct {
	VideoID   persistence.CanonicalUUID `json:"videoId"`
	Job       createVideoJobResponse    `json:"job"`
	Upload    createVideoUploadResponse `json:"upload"`
	CreatedAt time.Time                 `json:"createdAt"`
}
type createVideoJobResponse struct {
	JobID   persistence.CanonicalUUID   `json:"jobId"`
	Status  persistence.JobStatus       `json:"status"`
	Failure *createVideoFailureResponse `json:"failure"`
}
type createVideoFailureResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type createVideoUploadResponse struct {
	Method    string                    `json:"method"`
	URL       string                    `json:"url"`
	Headers   map[string]string         `json:"headers"`
	ExpiresAt time.Time                 `json:"expiresAt"`
	Object    createVideoObjectResponse `json:"object"`
}
type createVideoObjectResponse struct {
	Bucket string `json:"bucket"`
	Key    string `json:"key"`
}

func createVideoHandler(service *VideoCreationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req CreateVideoRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		result, err := service.CreateVideo(r.Context(), req)
		if err != nil {
			var validationErr *ValidationError
			if errors.As(err, &validationErr) {
				writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "The request body is invalid.")
				return
			}
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred.")
			return
		}
		headers := make(map[string]string, len(result.Upload.Headers))
		for name, values := range result.Upload.Headers {
			if len(values) > 0 {
				headers[name] = values[0]
			}
		}
		video := result.Video
		_ = writeJSON(w, http.StatusCreated, createVideoResponse{
			VideoID:   video.VideoID,
			Job:       createVideoJobResponse{JobID: video.Job.JobID, Status: video.Job.Status, Failure: nil},
			Upload:    createVideoUploadResponse{Method: result.Upload.Method, URL: result.Upload.URL, Headers: headers, ExpiresAt: video.Upload.ExpiresAt, Object: createVideoObjectResponse{Bucket: video.Upload.Bucket, Key: video.Upload.Key}},
			CreatedAt: video.CreatedAt,
		})
	}
}

func validateCreateVideoRequest(req CreateVideoRequest) error {
	nameLen := utf8.RuneCountInString(req.FileName)
	if nameLen < 1 || nameLen > maxFileNameLength {
		return &ValidationError{Field: "fileName", Reason: "must be between 1 and 255 characters"}
	}
	if req.ContentType != uploadContentType {
		return &ValidationError{Field: "contentType", Reason: "must be video/mp4"}
	}
	if req.SizeBytes <= 0 || req.SizeBytes > maxSizeBytes {
		return &ValidationError{Field: "sizeBytes", Reason: "must be between 1 and 5 GiB"}
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
