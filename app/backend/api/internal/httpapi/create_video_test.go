package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

var (
	testNow     = time.Date(2026, time.August, 25, 3, 0, 0, 0, time.UTC)
	testVideoID = persistence.CanonicalUUID("018f47a2-45c2-7a84-b84f-5f6dd7b5910a")
	testJobID   = persistence.CanonicalUUID("018f47a2-4699-7892-9fc0-fbe46d3bbd67")
)

func TestCreateVideoEndpointOrchestratesAndReturnsContractResponse(t *testing.T) {
	order := []string{}
	repo := &fakeVideoCreationRepo{order: &order}
	presigner := &fakeUploadPresigner{order: &order, result: PresignedUpload{Method: http.MethodPut, URL: "https://example.test/upload?secret", Headers: http.Header{"Content-Type": {"video/mp4"}}}}
	svc := testCreationService(repo, presigner)
	handler := NewRouterWithVideoCreation(svc)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(`{"fileName":"sample.mp4","contentType":"video/mp4","sizeBytes":104857600}`))
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if strings.Join(order, ",") != "presign,persist" {
		t.Fatalf("order = %v", order)
	}
	if presigner.bucket != "streaming-video-input" || presigner.contentType != "video/mp4" || presigner.expiry != 15*time.Minute {
		t.Fatalf("presign input = %#v", presigner)
	}
	var got createVideoResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.VideoID != testVideoID || got.Job.JobID != testJobID || got.Job.Status != persistence.JobStatusUploading || got.Job.Failure != nil {
		t.Fatalf("response job = %#v", got)
	}
	if got.Upload.Method != "PUT" || got.Upload.URL != presigner.result.URL || got.Upload.Headers["Content-Type"] != "video/mp4" {
		t.Fatalf("response upload = %#v", got.Upload)
	}
	if got.Upload.Object.Bucket != "streaming-video-input" || got.Upload.Object.Key != presigner.key {
		t.Fatalf("response object = %#v", got.Upload.Object)
	}
	if !got.Upload.ExpiresAt.Equal(testNow.Add(15*time.Minute)) || !got.CreatedAt.Equal(testNow) {
		t.Fatalf("response times = %v, %v", got.Upload.ExpiresAt, got.CreatedAt)
	}
}

func TestCreateVideoEndpointRejectsBadRequestsWithoutDependencies(t *testing.T) {
	tests := map[string]string{
		"invalid metadata": `{"fileName":"","contentType":"video/mp4","sizeBytes":1}`,
		"malformed":        `{"fileName":`,
		"unknown field":    `{"fileName":"x","contentType":"video/mp4","sizeBytes":1,"extra":true}`,
		"oversized":        `{"fileName":"` + strings.Repeat("a", requestBodyLimit) + `","contentType":"video/mp4","sizeBytes":1}`,
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			repo, signer := &fakeVideoCreationRepo{}, &fakeUploadPresigner{}
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(body))
			NewRouterWithVideoCreation(testCreationService(repo, signer)).ServeHTTP(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
			}
			if len(repo.inputs) != 0 || signer.calls != 0 {
				t.Fatalf("dependencies called: repo=%d signer=%d", len(repo.inputs), signer.calls)
			}
			var got ErrorResponse
			if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.Code != "INVALID_REQUEST" {
				t.Fatalf("code = %q", got.Code)
			}
		})
	}
}

func TestCreateVideoEndpointErrorBoundaries(t *testing.T) {
	t.Run("signing", func(t *testing.T) {
		repo := &fakeVideoCreationRepo{}
		signer := &fakeUploadPresigner{err: errors.New("sign failed")}
		rr := performValidCreate(testCreationService(repo, signer))
		assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
		if len(repo.inputs) != 0 {
			t.Fatal("repository called after signing failure")
		}
	})
	t.Run("persistence does not expose url", func(t *testing.T) {
		repo := &fakeVideoCreationRepo{err: errors.New("insert failed")}
		signer := &fakeUploadPresigner{result: PresignedUpload{Method: "PUT", URL: "https://example.test/?TOP-SECRET", Headers: http.Header{"Content-Type": {"video/mp4"}}}}
		rr := performValidCreate(testCreationService(repo, signer))
		assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
		if strings.Contains(rr.Body.String(), "TOP-SECRET") {
			t.Fatal("response exposed presigned URL")
		}
	})
}

func performValidCreate(svc *VideoCreationService) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(`{"fileName":"sample.mp4","contentType":"video/mp4","sizeBytes":1}`))
	NewRouterWithVideoCreation(svc).ServeHTTP(rr, req)
	return rr
}

func testCreationService(repo persistence.Repository, signer UploadPresigner) *VideoCreationService {
	ids := []persistence.CanonicalUUID{testVideoID, testJobID}
	index := 0
	return NewVideoCreationServiceWithDeps(repo, signer, "streaming-video-input", 15*time.Minute, func() time.Time { return testNow }, func() (persistence.CanonicalUUID, error) { id := ids[index]; index++; return id, nil })
}

type fakeUploadPresigner struct {
	order                    *[]string
	result                   PresignedUpload
	err                      error
	calls                    int
	bucket, key, contentType string
	expiry                   time.Duration
}

func (f *fakeUploadPresigner) PresignUpload(_ context.Context, bucket, key, contentType string, expiry time.Duration) (PresignedUpload, error) {
	f.calls++
	f.bucket, f.key, f.contentType, f.expiry = bucket, key, contentType, expiry
	if f.order != nil {
		*f.order = append(*f.order, "presign")
	}
	return f.result, f.err
}

type fakeVideoCreationRepo struct {
	order  *[]string
	inputs []persistence.CreateVideoInput
	err    error
}

func (r *fakeVideoCreationRepo) CreateVideo(_ context.Context, input persistence.CreateVideoInput) (persistence.Video, error) {
	if r.order != nil {
		*r.order = append(*r.order, "persist")
	}
	r.inputs = append(r.inputs, input)
	if r.err != nil {
		return persistence.Video{}, r.err
	}
	return persistence.Video{VideoID: input.VideoID, FileName: input.FileName, ContentType: input.ContentType, SizeBytes: input.SizeBytes, Upload: input.Upload, Job: persistence.EncodingJob{JobID: input.JobID, VideoID: input.VideoID, Status: persistence.JobStatusUploading}, CreatedAt: testNow, UpdatedAt: testNow}, nil
}
func (r *fakeVideoCreationRepo) GetVideoByID(context.Context, persistence.CanonicalUUID) (persistence.Video, error) {
	panic("unexpected GetVideoByID")
}
