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
	repo            persistence.Repository
	playbackBaseURL string
}

func NewVideoPlaybackService(repo persistence.Repository, playbackBaseURL string) *VideoPlaybackService {
	return &VideoPlaybackService{repo: repo, playbackBaseURL: playbackBaseURL}
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

		manifestKey, err := playbackManifestKey(video)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred.")
			return
		}
		manifestURL, err := buildDeliveryManifestURL(service.playbackBaseURL, manifestKey)
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

func playbackManifestKey(video persistence.Video) (string, error) {
	videoID, jobID := string(video.VideoID), string(video.Job.JobID)
	if !canonicalVideoIDPattern.MatchString(videoID) || !canonicalVideoIDPattern.MatchString(jobID) || video.Job.Attempt < 0 {
		return "", fmt.Errorf("invalid persisted playback identity")
	}
	switch video.Job.Mode {
	case persistence.JobModeCLI:
		if video.Job.PublishedManifestKey != nil {
			return "", fmt.Errorf("cli job has a published pointer")
		}
		return "videos/" + videoID + "/jobs/" + jobID + "/hls/index.m3u8", nil
	case persistence.JobModeDistributed:
		if video.Job.Attempt <= 0 || video.Job.PublishedManifestKey == nil {
			return "", fmt.Errorf("distributed job has no published pointer")
		}
		executionID := fmt.Sprintf("job-%s-a%d", jobID, video.Job.Attempt)
		expected := fmt.Sprintf("videos/%s/jobs/%s/hls/attempts/%d/%s/index.m3u8", videoID, jobID, video.Job.Attempt, executionID)
		if *video.Job.PublishedManifestKey != expected {
			return "", fmt.Errorf("invalid distributed published pointer")
		}
		return expected, nil
	default:
		return "", fmt.Errorf("unknown or unresolved job mode")
	}
}

func buildDeliveryManifestURL(baseURL string, parts ...any) (string, error) {
	var manifestKey string
	switch len(parts) {
	case 1:
		key, ok := parts[0].(string)
		if !ok {
			return "", fmt.Errorf("manifest key must be a string")
		}
		manifestKey = key
	case 2: // Kept for the existing URL-builder unit contract; playback uses the persisted key path above.
		videoID, videoOK := parts[0].(persistence.CanonicalUUID)
		jobID, jobOK := parts[1].(persistence.CanonicalUUID)
		if !videoOK || !jobOK || !canonicalVideoIDPattern.MatchString(string(videoID)) || !canonicalVideoIDPattern.MatchString(string(jobID)) {
			return "", fmt.Errorf("video and job IDs must be canonical UUIDs")
		}
		manifestKey = "videos/" + string(videoID) + "/jobs/" + string(jobID) + "/hls/index.m3u8"
	default:
		return "", fmt.Errorf("invalid manifest key arguments")
	}
	if strings.HasPrefix(manifestKey, "/") || strings.Contains(manifestKey, "..") || strings.Contains(manifestKey, "\\") {
		return "", fmt.Errorf("manifest key is invalid")
	}
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("playback base URL is invalid")
	}
	if base.User != nil || base.ForceQuery || base.RawQuery != "" || base.Fragment != "" || (base.Path != "" && base.Path != "/") {
		return "", fmt.Errorf("playback base URL must contain only a scheme and host")
	}
	base.Path = "/" + manifestKey
	return base.String(), nil
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
