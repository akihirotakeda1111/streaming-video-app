package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

func TestGetVideoUsesNewerJobUpdatedAt(t *testing.T) {
	createdAt := testNow
	videoUpdatedAt := createdAt
	jobUpdatedAt := createdAt.Add(2*time.Minute + 10*time.Second)
	repo := &fakeVideoStatusRepo{
		video: persistence.Video{
			VideoID:     testVideoID,
			FileName:    "sample.mp4",
			ContentType: "video/mp4",
			SizeBytes:   104857600,
			Job: persistence.EncodingJob{
				JobID:     testJobID,
				VideoID:   testVideoID,
				Status:    persistence.JobStatusProcessing,
				UpdatedAt: jobUpdatedAt,
			},
			CreatedAt: createdAt,
			UpdatedAt: videoUpdatedAt,
		},
	}

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/videos/"+string(testVideoID), nil)
	NewRouterWithVideoStatus(repo).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	var got videoStatusResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.UpdatedAt.Equal(jobUpdatedAt) {
		t.Fatalf("updatedAt = %v, want job timestamp %v", got.UpdatedAt, jobUpdatedAt)
	}
	if got.Job.Status != persistence.JobStatusProcessing {
		t.Fatalf("status = %q, want %q", got.Job.Status, persistence.JobStatusProcessing)
	}
}

type fakeVideoStatusRepo struct {
	video persistence.Video
}

func (r *fakeVideoStatusRepo) CreateVideo(context.Context, persistence.CreateVideoInput) (persistence.Video, error) {
	panic("unexpected CreateVideo")
}

func (r *fakeVideoStatusRepo) GetVideoByID(context.Context, persistence.CanonicalUUID) (persistence.Video, error) {
	return r.video, nil
}
