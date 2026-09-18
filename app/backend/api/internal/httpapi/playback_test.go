package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

const (
	testOutputBucket   = "streaming-video-output"
	testOutputEndpoint = "https://streaming-video-output.s3.ap-northeast-1.amazonaws.com"
)

func TestBuildManifestURLVirtualHostedOmitsBucketPath(t *testing.T) {
	got, err := buildManifestURL(testOutputEndpoint, testOutputBucket, testVideoID, testJobID)
	if err != nil {
		t.Fatalf("buildManifestURL() error = %v", err)
	}

	want := testOutputEndpoint + "/videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/index.m3u8"
	if got != want {
		t.Fatalf("manifest URL = %q, want %q", got, want)
	}
	if strings.Contains(got, "/streaming-video-output/videos/") {
		t.Fatalf("virtual-hosted URL unexpectedly includes the bucket in the path: %q", got)
	}
}

func TestBuildManifestURLPathStyleIncludesBucket(t *testing.T) {
	got, err := buildManifestURL("http://localhost:4566", "streaming-video-output-dev", testVideoID, testJobID)
	if err != nil {
		t.Fatalf("buildManifestURL() error = %v", err)
	}

	want := "http://localhost:4566/streaming-video-output-dev/videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/index.m3u8"
	if got != want {
		t.Fatalf("manifest URL = %q, want %q", got, want)
	}
}

func TestBuildManifestURLPreservesCanonicalKeys(t *testing.T) {
	got, err := buildManifestURL(testOutputEndpoint, testOutputBucket, testVideoID, testJobID)
	if err != nil {
		t.Fatalf("buildManifestURL() error = %v", err)
	}
	canonicalPath := "/videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/index.m3u8"
	if !strings.Contains(got, canonicalPath) {
		t.Fatalf("manifest URL = %q, want canonical key %q", got, canonicalPath)
	}
	if strings.Contains(strings.ToLower(got), "%2d") {
		t.Fatalf("canonical UUID hyphens were escaped: %q", got)
	}
}

func TestBuildManifestURLRejectsInvalidInput(t *testing.T) {
	tests := map[string]struct {
		endpoint string
		bucket   string
		videoID  persistence.CanonicalUUID
		jobID    persistence.CanonicalUUID
	}{
		"uppercase video id": {testOutputEndpoint, testOutputBucket, "018F47A2-45C2-7A84-B84F-5F6DD7B5910A", testJobID},
		"uppercase job id":   {testOutputEndpoint, testOutputBucket, testVideoID, "018F47A2-4699-7892-9FC0-FBE46D3BBD67"},
		"empty endpoint":     {"", testOutputBucket, testVideoID, testJobID},
		"missing scheme":     {"streaming-video-output.s3.ap-northeast-1.amazonaws.com", testOutputBucket, testVideoID, testJobID},
		"missing host":       {"https://", testOutputBucket, testVideoID, testJobID},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			got, err := buildManifestURL(tt.endpoint, tt.bucket, tt.videoID, tt.jobID)
			if err == nil {
				t.Fatalf("buildManifestURL() = %q, want error", got)
			}
			if got != "" {
				t.Fatalf("buildManifestURL() = %q, want empty URL on error", got)
			}
		})
	}
}

func TestGetVideoPlaybackReturnsVirtualHostedManifestURL(t *testing.T) {
	repo := &fakeVideoStatusRepo{video: completedPlaybackVideo()}
	rr := getPlayback(repo, string(testVideoID), testOutputBucket, testOutputEndpoint)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	var got playbackResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := testOutputEndpoint + "/videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/index.m3u8"
	if got.VideoID != testVideoID || got.JobID != testJobID {
		t.Fatalf("ids = %#v", got)
	}
	if got.ManifestURL != want {
		t.Fatalf("manifestUrl = %q, want %q", got.ManifestURL, want)
	}
	if got.Protocol != "HLS" || got.ContentType != playbackContentType {
		t.Fatalf("playback = %#v", got)
	}
}

func TestGetVideoPlaybackStatusBranches(t *testing.T) {
	for _, status := range persistence.AllJobStatuses {
		t.Run(string(status), func(t *testing.T) {
			repo := &fakeVideoStatusRepo{
				video: persistence.Video{
					VideoID: testVideoID,
					Job: persistence.EncodingJob{
						JobID:  testJobID,
						Status: status,
						Mode:   persistence.JobModeCLI,
					},
				},
			}
			rr := getPlayback(repo, string(testVideoID), testOutputBucket, testOutputEndpoint)
			body := rr.Body.Bytes()

			if status == persistence.JobStatusCompleted {
				if rr.Code != http.StatusOK {
					t.Fatalf("status = %d, body = %s", rr.Code, body)
				}
				return
			}

			if strings.Contains(string(body), "manifestUrl") || strings.Contains(string(body), "index.m3u8") {
				t.Fatalf("%s response leaked playback URL: %s", status, body)
			}
			if !jsonMessageEquals(body, "The video is still being processed.") {
				t.Fatalf("message = %s", body)
			}
			assertErrorResponse(t, rr, http.StatusConflict, "VIDEO_NOT_READY")
			if repo.getCalls != 1 {
				t.Fatalf("GetVideoByID calls = %d, want 1", repo.getCalls)
			}
		})
	}
}

func TestGetVideoPlaybackNotFound(t *testing.T) {
	repo := &fakeVideoStatusRepo{err: persistence.ErrNotFound}
	rr := getPlayback(repo, string(testVideoID), testOutputBucket, testOutputEndpoint)
	if !jsonMessageEquals(rr.Body.Bytes(), "The requested video does not exist.") {
		t.Fatalf("message = %s", rr.Body.String())
	}
	assertErrorResponse(t, rr, http.StatusNotFound, "VIDEO_NOT_FOUND")
	if repo.getCalls != 1 {
		t.Fatalf("GetVideoByID calls = %d, want 1", repo.getCalls)
	}
}

func TestGetVideoPlaybackNotFoundWrapped(t *testing.T) {
	repo := &fakeVideoStatusRepo{err: fmt.Errorf("query video: %w", persistence.ErrNotFound)}
	rr := getPlayback(repo, string(testVideoID), testOutputBucket, testOutputEndpoint)
	assertErrorResponse(t, rr, http.StatusNotFound, "VIDEO_NOT_FOUND")
}

func TestGetVideoPlaybackDatabaseError(t *testing.T) {
	repo := &fakeVideoStatusRepo{err: errors.New("connection refused")}
	rr := getPlayback(repo, string(testVideoID), testOutputBucket, testOutputEndpoint)
	assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
	if repo.getCalls != 1 {
		t.Fatalf("GetVideoByID calls = %d, want 1", repo.getCalls)
	}
}

func TestGetVideoPlaybackRejectsInvalidUUIDWithoutRepository(t *testing.T) {
	tests := map[string]string{
		"not a uuid":    "not-a-uuid",
		"uppercase":     "018F47A2-45C2-7A84-B84F-5F6DD7B5910A",
		"no hyphens":    "018f47a245c27a84b84f5f6dd7b5910a",
		"too short":     "018f47a2-45c2-7a84-b84f-5f6dd7b5910",
		"too long":      "018f47a2-45c2-7a84-b84f-5f6dd7b5910aa",
		"uppercase hex": "018f47a2-45c2-7a84-b84f-5f6dd7b5910A",
	}
	for name, videoID := range tests {
		t.Run(name, func(t *testing.T) {
			repo := &fakeVideoStatusRepo{}
			rr := getPlayback(repo, videoID, testOutputBucket, testOutputEndpoint)
			if !jsonMessageEquals(rr.Body.Bytes(), "The videoId must be a canonical lowercase UUID.") {
				t.Fatalf("message = %s", rr.Body.String())
			}
			assertErrorResponse(t, rr, http.StatusBadRequest, "INVALID_REQUEST")
			if repo.getCalls != 0 {
				t.Fatalf("GetVideoByID calls = %d, want 0", repo.getCalls)
			}
		})
	}
}

func TestGetVideoPlaybackRejectsCorruptStoredState(t *testing.T) {
	tests := map[string]persistence.JobStatus{
		"unknown status": persistence.JobStatus("UNKNOWN"),
		"empty status":   "",
	}
	for name, status := range tests {
		t.Run(name, func(t *testing.T) {
			repo := &fakeVideoStatusRepo{
				video: persistence.Video{
					VideoID: testVideoID,
					Job: persistence.EncodingJob{
						JobID:  testJobID,
						Status: status,
					},
				},
			}
			rr := getPlayback(repo, string(testVideoID), testOutputBucket, testOutputEndpoint)
			assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
			if repo.getCalls != 1 {
				t.Fatalf("GetVideoByID calls = %d, want 1", repo.getCalls)
			}
		})
	}
}

func TestGetVideoPlaybackModeAndPointerCombinations(t *testing.T) {
	legacyKey := legacyPlaybackManifestKey()
	validPointer := distributedParentMasterKey(1)
	legacyURL := testOutputEndpoint + "/" + legacyKey
	distributedURL := testOutputEndpoint + "/" + validPointer

	tests := []struct {
		name       string
		job        persistence.EncodingJob
		wantStatus int
		wantCode   string
		wantURL    string
	}{
		{
			name: "completed cli null pointer returns legacy url",
			job: persistence.EncodingJob{
				JobID:  testJobID,
				Status: persistence.JobStatusCompleted,
				Mode:   persistence.JobModeCLI,
			},
			wantStatus: http.StatusOK,
			wantURL:    legacyURL,
		},
		{
			name: "completed distributed valid pointer returns published key",
			job: persistence.EncodingJob{
				JobID:                testJobID,
				Status:               persistence.JobStatusCompleted,
				Mode:                 persistence.JobModeDistributed,
				Attempt:              1,
				PublishedManifestKey: stringPtr(validPointer),
			},
			wantStatus: http.StatusOK,
			wantURL:    distributedURL,
		},
		{
			name: "completed distributed null pointer is internal error",
			job: persistence.EncodingJob{
				JobID:   testJobID,
				Status:  persistence.JobStatusCompleted,
				Mode:    persistence.JobModeDistributed,
				Attempt: 1,
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
		{
			name: "completed distributed invalid pointer is internal error",
			job: persistence.EncodingJob{
				JobID:                testJobID,
				Status:               persistence.JobStatusCompleted,
				Mode:                 persistence.JobModeDistributed,
				Attempt:              1,
				PublishedManifestKey: stringPtr("videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/index.m3u8"),
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
		{
			name: "completed distributed absolute url pointer is internal error",
			job: persistence.EncodingJob{
				JobID:                testJobID,
				Status:               persistence.JobStatusCompleted,
				Mode:                 persistence.JobModeDistributed,
				Attempt:              1,
				PublishedManifestKey: stringPtr("https://example.test/" + validPointer),
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
		{
			name: "completed distributed traversal pointer is internal error",
			job: persistence.EncodingJob{
				JobID:                testJobID,
				Status:               persistence.JobStatusCompleted,
				Mode:                 persistence.JobModeDistributed,
				Attempt:              1,
				PublishedManifestKey: stringPtr("videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/attempts/1/job-" + string(testJobID) + "-a1/../index.m3u8"),
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
		{
			name: "completed distributed other job pointer is internal error",
			job: persistence.EncodingJob{
				JobID:                testJobID,
				Status:               persistence.JobStatusCompleted,
				Mode:                 persistence.JobModeDistributed,
				Attempt:              1,
				PublishedManifestKey: stringPtr("videos/" + string(testVideoID) + "/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd68/hls/attempts/1/job-018f47a2-4699-7892-9fc0-fbe46d3bbd68-a1/index.m3u8"),
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
		{
			name: "completed distributed encoded traversal pointer is internal error",
			job: persistence.EncodingJob{
				JobID:                testJobID,
				Status:               persistence.JobStatusCompleted,
				Mode:                 persistence.JobModeDistributed,
				Attempt:              1,
				PublishedManifestKey: stringPtr("videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/attempts/1/%2e%2e/index.m3u8"),
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
		{
			name: "completed cli non-null pointer is internal error",
			job: persistence.EncodingJob{
				JobID:                testJobID,
				Status:               persistence.JobStatusCompleted,
				Mode:                 persistence.JobModeCLI,
				PublishedManifestKey: stringPtr(legacyKey),
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
		{
			name: "completed null mode is internal error",
			job: persistence.EncodingJob{
				JobID:  testJobID,
				Status: persistence.JobStatusCompleted,
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
		{
			name: "completed unknown mode is internal error",
			job: persistence.EncodingJob{
				JobID:  testJobID,
				Status: persistence.JobStatusCompleted,
				Mode:   persistence.JobMode("batch"),
			},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &fakeVideoStatusRepo{
				video: persistence.Video{VideoID: testVideoID, Job: tt.job},
			}
			rr := getPlayback(repo, string(testVideoID), testOutputBucket, testOutputEndpoint)
			body := rr.Body.Bytes()

			if tt.wantStatus == http.StatusOK {
				if rr.Code != http.StatusOK {
					t.Fatalf("status = %d, body = %s", rr.Code, body)
				}
				var got playbackResponse
				if err := json.Unmarshal(body, &got); err != nil {
					t.Fatal(err)
				}
				if got.ManifestURL != tt.wantURL {
					t.Fatalf("manifestUrl = %q, want %q", got.ManifestURL, tt.wantURL)
				}
				if got.VideoID != testVideoID || got.JobID != testJobID || got.Protocol != "HLS" || got.ContentType != playbackContentType {
					t.Fatalf("playback = %#v", got)
				}
				return
			}

			if strings.Contains(string(body), "manifestUrl") || strings.Contains(string(body), "index.m3u8") {
				t.Fatalf("inconsistent playback leaked manifest URL: %s", body)
			}
			assertErrorResponse(t, rr, tt.wantStatus, tt.wantCode)
		})
	}
}

func TestGetVideoPlaybackURLGenerationFailure(t *testing.T) {
	tests := map[string]struct {
		video    persistence.Video
		endpoint string
	}{
		"invalid endpoint": {
			video:    completedPlaybackVideo(),
			endpoint: "not-a-url",
		},
		"empty endpoint": {
			video:    completedPlaybackVideo(),
			endpoint: "",
		},
		"non-canonical stored video id": {
			video: persistence.Video{
				VideoID: "not-a-uuid",
				Job: persistence.EncodingJob{
					JobID:  testJobID,
					Status: persistence.JobStatusCompleted,
					Mode:   persistence.JobModeCLI,
				},
			},
			endpoint: testOutputEndpoint,
		},
		"non-canonical stored job id": {
			video: persistence.Video{
				VideoID: testVideoID,
				Job: persistence.EncodingJob{
					JobID:  "018F47A2-4699-7892-9FC0-FBE46D3BBD67",
					Status: persistence.JobStatusCompleted,
				},
			},
			endpoint: testOutputEndpoint,
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			repo := &fakeVideoStatusRepo{video: tt.video}
			rr := getPlayback(repo, string(testVideoID), testOutputBucket, tt.endpoint)
			body := rr.Body.Bytes()
			if strings.Contains(string(body), "index.m3u8") {
				t.Fatalf("URL generation failure leaked manifest URL: %s", body)
			}
			assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
		})
	}
}

func completedPlaybackVideo() persistence.Video {
	return persistence.Video{
		VideoID: testVideoID,
		Job: persistence.EncodingJob{
			JobID:  testJobID,
			Status: persistence.JobStatusCompleted,
			Mode:   persistence.JobModeCLI,
		},
	}
}

func legacyPlaybackManifestKey() string {
	return "videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/index.m3u8"
}

func distributedParentMasterKey(attempt int) string {
	executionID := fmt.Sprintf("job-%s-a%d", testJobID, attempt)
	return fmt.Sprintf("videos/%s/jobs/%s/hls/attempts/%d/%s/index.m3u8", testVideoID, testJobID, attempt, executionID)
}

func stringPtr(value string) *string {
	return &value
}

func getPlayback(repo persistence.Repository, videoID, bucket, endpoint string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/videos/"+videoID+"/playback", nil)
	NewRouterWithVideoPlayback(repo, endpoint).ServeHTTP(rr, req)
	return rr
}

func TestBuildDeliveryManifestURL(t *testing.T) {
	legacyKey := legacyPlaybackManifestKey()
	distributedKey := distributedParentMasterKey(1)
	for _, origin := range []string{"https://test.cloudfront.net", "https://test.cloudfront.net/", "http://localhost:4567"} {
		for _, key := range []string{legacyKey, distributedKey} {
			got, err := buildDeliveryManifestURL(origin, key)
			want := strings.TrimSuffix(origin, "/") + "/" + key
			if err != nil || got != want {
				t.Errorf("origin %q key %q: got %q, %v; want %q", origin, key, got, err, want)
			}
		}
	}
	for _, origin := range []string{"", "https://", "https://test.cloudfront.net//", "https://test.cloudfront.net/bucket", "https://user:pass@test.cloudfront.net", "https://test.cloudfront.net?key=value", "https://test.cloudfront.net?", "https://test.cloudfront.net#fragment"} {
		if got, err := buildDeliveryManifestURL(origin, legacyKey); err == nil || got != "" {
			t.Errorf("invalid origin %q: got %q, %v", origin, got, err)
		}
	}
	for _, key := range []string{"/" + legacyKey, "videos/../" + legacyKey, `videos\` + string(testVideoID) + "/index.m3u8"} {
		if got, err := buildDeliveryManifestURL("https://test.cloudfront.net", key); err == nil || got != "" {
			t.Errorf("invalid key %q: got %q, %v", key, got, err)
		}
	}
}
