package httpapi

import (
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

var canonicalVideoIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// VideoStatusService reads the current video and encoding job state.
type VideoStatusService struct {
	repo persistence.Repository
}

func NewVideoStatusService(repo persistence.Repository) *VideoStatusService {
	return &VideoStatusService{repo: repo}
}

type videoStatusResponse struct {
	VideoID     persistence.CanonicalUUID `json:"videoId"`
	FileName    string                    `json:"fileName"`
	ContentType string                    `json:"contentType"`
	SizeBytes   int64                     `json:"sizeBytes"`
	Job         videoStatusJobResponse    `json:"job"`
	CreatedAt   time.Time                 `json:"createdAt"`
	UpdatedAt   time.Time                 `json:"updatedAt"`
}

type videoStatusJobResponse struct {
	JobID   persistence.CanonicalUUID   `json:"jobId"`
	Status  persistence.JobStatus       `json:"status"`
	Failure *createVideoFailureResponse `json:"failure"`
}

func getVideoHandler(service *VideoStatusService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("videoId")
		if !canonicalVideoIDPattern.MatchString(id) {
			writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "The videoId must be a canonical lowercase UUID.")
			return
		}
		if service == nil || service.repo == nil {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred.")
			return
		}

		video, err := service.repo.GetVideoByID(r.Context(), persistence.CanonicalUUID(id))
		if err != nil {
			if errors.Is(err, persistence.ErrNotFound) {
				writeError(w, http.StatusNotFound, "VIDEO_NOT_FOUND", "The requested video does not exist.")
				return
			}
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred.")
			return
		}
		if !video.Job.Status.IsValid() || (video.Job.Status == persistence.JobStatusFailed &&
			(video.Job.Failure == nil || video.Job.Failure.Code == "" || video.Job.Failure.Message == "")) {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred.")
			return
		}

		var failure *createVideoFailureResponse
		if video.Job.Status == persistence.JobStatusFailed {
			failure = &createVideoFailureResponse{Code: video.Job.Failure.Code, Message: video.Job.Failure.Message}
		}
		_ = writeJSON(w, http.StatusOK, videoStatusResponse{
			VideoID: video.VideoID, FileName: video.FileName, ContentType: video.ContentType,
			SizeBytes: video.SizeBytes,
			Job:       videoStatusJobResponse{JobID: video.Job.JobID, Status: video.Job.Status, Failure: failure},
			CreatedAt: video.CreatedAt, UpdatedAt: videoStatusUpdatedAt(video),
		})
	}
}

func videoStatusUpdatedAt(video persistence.Video) time.Time {
	if video.Job.UpdatedAt.After(video.UpdatedAt) {
		return video.Job.UpdatedAt
	}
	return video.UpdatedAt
}
