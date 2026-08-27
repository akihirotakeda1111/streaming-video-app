package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

func TestBuildManifestURLVirtualHostedOmitsBucketPath(t *testing.T) {
	got, err := buildManifestURL(
		"https://streaming-video-output.s3.ap-northeast-1.amazonaws.com",
		"streaming-video-output",
		testVideoID,
		testJobID,
	)
	if err != nil {
		t.Fatalf("buildManifestURL() error = %v", err)
	}

	want := "https://streaming-video-output.s3.ap-northeast-1.amazonaws.com/videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/index.m3u8"
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

func TestGetVideoPlaybackReturnsVirtualHostedManifestURL(t *testing.T) {
	repo := &fakeVideoStatusRepo{
		video: persistence.Video{
			VideoID: testVideoID,
			Job: persistence.EncodingJob{
				JobID:  testJobID,
				Status: persistence.JobStatusCompleted,
			},
		},
	}

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/videos/"+string(testVideoID)+"/playback", nil)
	NewRouterWithVideoPlayback(repo, "streaming-video-output", "https://streaming-video-output.s3.ap-northeast-1.amazonaws.com").ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	var got playbackResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := "https://streaming-video-output.s3.ap-northeast-1.amazonaws.com/videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/hls/index.m3u8"
	if got.ManifestURL != want {
		t.Fatalf("manifestUrl = %q, want %q", got.ManifestURL, want)
	}
	if got.Protocol != "HLS" || got.ContentType != playbackContentType {
		t.Fatalf("playback = %#v", got)
	}
}
