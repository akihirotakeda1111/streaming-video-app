package httpapi

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

const playbackContentType = "application/vnd.apple.mpegurl"

// VideoPlaybackService resolves playback information for completed videos.
type VideoPlaybackService struct {
	repo           persistence.Repository
	outputBucket   string
	outputEndpoint string
}

func NewVideoPlaybackService(repo persistence.Repository, outputBucket, outputEndpoint string) *VideoPlaybackService {
	return &VideoPlaybackService{repo: repo, outputBucket: outputBucket, outputEndpoint: outputEndpoint}
}

type playbackResponse struct {
	VideoID     persistence.CanonicalUUID `json:"videoId"`
	JobID       persistence.CanonicalUUID `json:"jobId"`
	Protocol    string                    `json:"protocol"`
	ManifestURL string                    `json:"manifestUrl"`
	ContentType string                    `json:"contentType"`
}

func getVideoPlaybackHandler(service *VideoPlaybackService) http.HandlerFunc {
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
		if !video.Job.Status.IsValid() {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred.")
			return
		}
		if video.Job.Status != persistence.JobStatusCompleted {
			writeError(w, http.StatusConflict, "VIDEO_NOT_READY", "The video is still being processed.")
			return
		}

		manifestURL, err := buildManifestURL(service.outputEndpoint, service.outputBucket, video.VideoID, video.Job.JobID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred.")
			return
		}
		_ = writeJSON(w, http.StatusOK, playbackResponse{
			VideoID: video.VideoID, JobID: video.Job.JobID, Protocol: "HLS",
			ManifestURL: manifestURL, ContentType: playbackContentType,
		})
	}
}

func buildManifestURL(endpoint, bucket string, videoID, jobID persistence.CanonicalUUID) (string, error) {
	if !canonicalVideoIDPattern.MatchString(string(videoID)) || !canonicalVideoIDPattern.MatchString(string(jobID)) {
		return "", fmt.Errorf("video and job IDs must be canonical UUIDs")
	}
	base, err := url.Parse(endpoint)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("output S3 endpoint is invalid")
	}
	objectPath := "/videos/" + url.PathEscape(string(videoID)) + "/jobs/" + url.PathEscape(string(jobID)) + "/hls/index.m3u8"
	prefix := strings.TrimRight(base.Path, "/")
	if isVirtualHostedS3Endpoint(base.Host, bucket) {
		base.Path = prefix + objectPath
	} else {
		base.Path = prefix + "/" + url.PathEscape(bucket) + objectPath
	}
	return base.String(), nil
}

func isVirtualHostedS3Endpoint(host, bucket string) bool {
	hostname := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		hostname = h
	}
	return strings.HasPrefix(strings.ToLower(hostname), strings.ToLower(bucket)+".s3.")
}
