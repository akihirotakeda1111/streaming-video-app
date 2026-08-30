package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

	rr := getVideo(repo, string(testVideoID))

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

func TestGetVideoReturnsContractStatuses(t *testing.T) {
	createdAt := testNow
	videoUpdatedAt := createdAt.Add(time.Minute)

	tests := []struct {
		name        string
		status      persistence.JobStatus
		failure     *persistence.JobFailure
		jobUpdated  time.Time
		wantUpdated time.Time
		wantFailure *createVideoFailureResponse
	}{
		{
			name:        "UPLOADING",
			status:      persistence.JobStatusUploading,
			jobUpdated:  createdAt,
			wantUpdated: videoUpdatedAt,
		},
		{
			name:        "QUEUED",
			status:      persistence.JobStatusQueued,
			jobUpdated:  createdAt.Add(90 * time.Second),
			wantUpdated: createdAt.Add(90 * time.Second),
		},
		{
			name:        "PROCESSING",
			status:      persistence.JobStatusProcessing,
			jobUpdated:  createdAt.Add(2*time.Minute + 10*time.Second),
			wantUpdated: createdAt.Add(2*time.Minute + 10*time.Second),
		},
		{
			name:        "COMPLETED",
			status:      persistence.JobStatusCompleted,
			jobUpdated:  createdAt.Add(4*time.Minute + 52*time.Second),
			wantUpdated: createdAt.Add(4*time.Minute + 52*time.Second),
		},
		{
			name:        "FAILED",
			status:      persistence.JobStatusFailed,
			failure:     &persistence.JobFailure{Code: "ENCODING_FAILED", Message: "The encoder rejected the source file."},
			jobUpdated:  createdAt.Add(3 * time.Minute),
			wantUpdated: createdAt.Add(3 * time.Minute),
			wantFailure: &createVideoFailureResponse{Code: "ENCODING_FAILED", Message: "The encoder rejected the source file."},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &fakeVideoStatusRepo{
				video: persistence.Video{
					VideoID:     testVideoID,
					FileName:    "sample.mp4",
					ContentType: "video/mp4",
					SizeBytes:   104857600,
					Job: persistence.EncodingJob{
						JobID:     testJobID,
						VideoID:   testVideoID,
						Status:    tt.status,
						Failure:   tt.failure,
						UpdatedAt: tt.jobUpdated,
					},
					CreatedAt: createdAt,
					UpdatedAt: videoUpdatedAt,
				},
			}

			rr := getVideo(repo, string(testVideoID))
			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
			}
			if repo.getCalls != 1 {
				t.Fatalf("GetVideoByID calls = %d, want 1", repo.getCalls)
			}
			if repo.gotID != testVideoID {
				t.Fatalf("GetVideoByID id = %q, want %q", repo.gotID, testVideoID)
			}

			var got videoStatusResponse
			if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.VideoID != testVideoID {
				t.Fatalf("videoId = %q, want %q", got.VideoID, testVideoID)
			}
			if got.FileName != "sample.mp4" || got.ContentType != "video/mp4" || got.SizeBytes != 104857600 {
				t.Fatalf("file metadata = %#v", got)
			}
			if got.Job.JobID != testJobID {
				t.Fatalf("jobId = %q, want %q", got.Job.JobID, testJobID)
			}
			if got.Job.Status != tt.status {
				t.Fatalf("status = %q, want %q", got.Job.Status, tt.status)
			}
			if !got.CreatedAt.Equal(createdAt) {
				t.Fatalf("createdAt = %v, want %v", got.CreatedAt, createdAt)
			}
			if !got.UpdatedAt.Equal(tt.wantUpdated) {
				t.Fatalf("updatedAt = %v, want %v", got.UpdatedAt, tt.wantUpdated)
			}
			assertJobFailureJSON(t, rr.Body.Bytes(), tt.wantFailure)
		})
	}
}

func TestGetVideoNotFound(t *testing.T) {
	repo := &fakeVideoStatusRepo{err: persistence.ErrNotFound}
	rr := getVideo(repo, string(testVideoID))
	if !jsonMessageEquals(rr.Body.Bytes(), "The requested video does not exist.") {
		t.Fatalf("message = %s", rr.Body.String())
	}
	assertErrorResponse(t, rr, http.StatusNotFound, "VIDEO_NOT_FOUND")
	if repo.getCalls != 1 {
		t.Fatalf("GetVideoByID calls = %d, want 1", repo.getCalls)
	}
}

func TestGetVideoNotFoundWrapped(t *testing.T) {
	repo := &fakeVideoStatusRepo{err: fmt.Errorf("query video: %w", persistence.ErrNotFound)}
	rr := getVideo(repo, string(testVideoID))
	assertErrorResponse(t, rr, http.StatusNotFound, "VIDEO_NOT_FOUND")
}

func TestGetVideoDatabaseError(t *testing.T) {
	repo := &fakeVideoStatusRepo{err: errors.New("connection refused")}
	rr := getVideo(repo, string(testVideoID))
	assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
	if repo.getCalls != 1 {
		t.Fatalf("GetVideoByID calls = %d, want 1", repo.getCalls)
	}
}

func TestGetVideoRejectsInvalidUUIDWithoutRepository(t *testing.T) {
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
			rr := getVideo(repo, videoID)
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

func TestGetVideoRejectsCorruptStoredState(t *testing.T) {
	createdAt := testNow
	tests := map[string]persistence.EncodingJob{
		"unknown status": {
			JobID:  testJobID,
			Status: persistence.JobStatus("UNKNOWN"),
		},
		"empty status": {
			JobID: testJobID,
		},
		"failed without details": {
			JobID:  testJobID,
			Status: persistence.JobStatusFailed,
		},
		"failed empty code": {
			JobID:   testJobID,
			Status:  persistence.JobStatusFailed,
			Failure: &persistence.JobFailure{Message: "encoder crashed"},
		},
		"failed empty message": {
			JobID:   testJobID,
			Status:  persistence.JobStatusFailed,
			Failure: &persistence.JobFailure{Code: "ENCODING_FAILED"},
		},
	}
	for name, job := range tests {
		t.Run(name, func(t *testing.T) {
			job.VideoID = testVideoID
			job.UpdatedAt = createdAt
			repo := &fakeVideoStatusRepo{
				video: persistence.Video{
					VideoID:     testVideoID,
					FileName:    "sample.mp4",
					ContentType: "video/mp4",
					SizeBytes:   104857600,
					Job:         job,
					CreatedAt:   createdAt,
					UpdatedAt:   createdAt,
				},
			}
			rr := getVideo(repo, string(testVideoID))
			assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
			if repo.getCalls != 1 {
				t.Fatalf("GetVideoByID calls = %d, want 1", repo.getCalls)
			}
		})
	}
}

func getVideo(repo persistence.Repository, videoID string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/videos/"+videoID, nil)
	NewRouterWithVideoStatus(repo).ServeHTTP(rr, req)
	return rr
}

func assertJobFailureJSON(t *testing.T, body []byte, want *createVideoFailureResponse) {
	t.Helper()

	var payload struct {
		Job struct {
			Failure json.RawMessage `json:"failure"`
		} `json:"job"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if want == nil {
		if string(payload.Job.Failure) != "null" {
			t.Fatalf("failure = %s, want null", payload.Job.Failure)
		}
		return
	}
	var got createVideoFailureResponse
	if err := json.Unmarshal(payload.Job.Failure, &got); err != nil {
		t.Fatal(err)
	}
	if got != *want {
		t.Fatalf("failure = %#v, want %#v", got, *want)
	}
}

func jsonMessageEquals(body []byte, want string) bool {
	var got ErrorResponse
	if err := json.Unmarshal(body, &got); err != nil {
		return false
	}
	return got.Message == want
}

type fakeVideoStatusRepo struct {
	video    persistence.Video
	err      error
	getCalls int
	gotID    persistence.CanonicalUUID
}

func (r *fakeVideoStatusRepo) CreateVideo(context.Context, persistence.CreateVideoInput) (persistence.Video, error) {
	panic("unexpected CreateVideo")
}

func (r *fakeVideoStatusRepo) GetVideoByID(_ context.Context, id persistence.CanonicalUUID) (persistence.Video, error) {
	r.getCalls++
	r.gotID = id
	if r.err != nil {
		return persistence.Video{}, r.err
	}
	return r.video, nil
}
