package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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
	wantKey := "videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/source.mp4"
	if presigner.key != wantKey || strings.Contains(presigner.key, "sample.mp4") {
		t.Fatalf("upload key = %q, want exact canonical key", presigner.key)
	}
	if len(repo.inputs) != 1 || repo.inputs[0].Upload.Key != wantKey || repo.inputs[0].FileName != "sample.mp4" {
		t.Fatalf("persisted input = %#v", repo.inputs)
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
	if got.Upload.Object.Bucket != "streaming-video-input" || got.Upload.Object.Key != wantKey {
		t.Fatalf("response object = %#v", got.Upload.Object)
	}
	if !got.Upload.ExpiresAt.Equal(testNow.Add(15*time.Minute)) || !got.CreatedAt.Equal(testNow) {
		t.Fatalf("response times = %v, %v", got.Upload.ExpiresAt, got.CreatedAt)
	}
	assertJobFailureJSON(t, rr.Body.Bytes(), nil)
}

func TestCreateVideoContractExamples(t *testing.T) {
	requestBody := readContractExample(t, "create-video-request.json")
	exampleResponse := readContractExample(t, "create-video-response.json")

	var exampleReq CreateVideoRequest
	if err := json.Unmarshal(requestBody, &exampleReq); err != nil {
		t.Fatal(err)
	}
	if exampleReq.FileName != "sample.mp4" || exampleReq.ContentType != "video/mp4" || exampleReq.SizeBytes != 104857600 {
		t.Fatalf("contract request = %#v", exampleReq)
	}

	var exampleObj map[string]any
	if err := json.Unmarshal(exampleResponse, &exampleObj); err != nil {
		t.Fatal(err)
	}
	repo := &fakeVideoCreationRepo{}
	presigner := &fakeUploadPresigner{result: PresignedUpload{
		Method:  http.MethodPut,
		URL:     exampleObj["upload"].(map[string]any)["url"].(string),
		Headers: http.Header{"Content-Type": {"video/mp4"}},
	}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(string(requestBody)))
	NewRouterWithVideoCreation(testCreationService(repo, presigner)).ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	assertJSONKeysMatch(t, rr.Body.Bytes(), exampleResponse, "")
	assertJobFailureJSON(t, rr.Body.Bytes(), nil)

	var got createVideoResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.VideoID != testVideoID || got.Job.JobID != testJobID || got.Job.Status != persistence.JobStatusUploading {
		t.Fatalf("response ids = %#v", got)
	}
	if got.Upload.Method != "PUT" || got.Upload.Headers["Content-Type"] != "video/mp4" {
		t.Fatalf("upload = %#v", got.Upload)
	}
	if got.Upload.Object.Key != "videos/"+string(testVideoID)+"/jobs/"+string(testJobID)+"/source.mp4" {
		t.Fatalf("object key = %q", got.Upload.Object.Key)
	}
	if !got.CreatedAt.Equal(testNow) || !got.Upload.ExpiresAt.Equal(testNow.Add(15*time.Minute)) {
		t.Fatalf("times = %v, %v", got.CreatedAt, got.Upload.ExpiresAt)
	}
}

func TestCreateVideoEndpointRejectsBadRequestsWithoutDependencies(t *testing.T) {
	tests := map[string]string{
		"empty fileName":          `{"fileName":"","contentType":"video/mp4","sizeBytes":1}`,
		"fileName 256 characters": `{"fileName":"` + strings.Repeat("a", 256) + `","contentType":"video/mp4","sizeBytes":1}`,
		"invalid content type":    `{"fileName":"sample.mp4","contentType":"video/webm","sizeBytes":1}`,
		"uppercase content type":  `{"fileName":"sample.mp4","contentType":"VIDEO/MP4","sizeBytes":1}`,
		"empty content type":      `{"fileName":"sample.mp4","contentType":"","sizeBytes":1}`,
		"sizeBytes zero":          `{"fileName":"sample.mp4","contentType":"video/mp4","sizeBytes":0}`,
		"sizeBytes negative":      `{"fileName":"sample.mp4","contentType":"video/mp4","sizeBytes":-1}`,
		"sizeBytes over 5 GiB":    `{"fileName":"sample.mp4","contentType":"video/mp4","sizeBytes":5368709121}`,
		"missing fileName":        `{"contentType":"video/mp4","sizeBytes":1}`,
		"missing contentType":     `{"fileName":"sample.mp4","sizeBytes":1}`,
		"missing sizeBytes":       `{"fileName":"sample.mp4","contentType":"video/mp4"}`,
		"malformed":               `{"fileName":`,
		"unknown field":           `{"fileName":"x","contentType":"video/mp4","sizeBytes":1,"extra":true}`,
		"http body over 1 MiB":    `{"fileName":"` + strings.Repeat("a", requestBodyLimit) + `","contentType":"video/mp4","sizeBytes":1}`,
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

func TestCreateVideoEndpointAcceptsDomainBoundaries(t *testing.T) {
	tests := map[string]CreateVideoRequest{
		"fileName 255 characters": {FileName: strings.Repeat("n", 255), ContentType: "video/mp4", SizeBytes: 1024},
		"sizeBytes 1":             {FileName: "a.mp4", ContentType: "video/mp4", SizeBytes: 1},
		"sizeBytes 5 GiB":         {FileName: "a.mp4", ContentType: "video/mp4", SizeBytes: maxSizeBytes},
	}
	for name, payload := range tests {
		t.Run(name, func(t *testing.T) {
			repo, signer := &fakeVideoCreationRepo{}, &fakeUploadPresigner{result: PresignedUpload{Method: http.MethodPut, URL: "https://example.test/u", Headers: http.Header{"Content-Type": {"video/mp4"}}}}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(string(body)))
			NewRouterWithVideoCreation(testCreationService(repo, signer)).ServeHTTP(rr, req)
			if rr.Code != http.StatusCreated {
				t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
			}
			if signer.calls != 1 || len(repo.inputs) != 1 {
				t.Fatalf("dependencies: signer=%d repo=%d", signer.calls, len(repo.inputs))
			}
			if repo.inputs[0].FileName != payload.FileName || repo.inputs[0].SizeBytes != payload.SizeBytes {
				t.Fatalf("persisted = %#v", repo.inputs[0])
			}
			wantKey := "videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/source.mp4"
			if repo.inputs[0].Upload.Key != wantKey || strings.Contains(repo.inputs[0].Upload.Key, payload.FileName) {
				t.Fatalf("key = %q, want canonical key without client file name", repo.inputs[0].Upload.Key)
			}
		})
	}
}

func TestCreateVideoEndpointIDGenerationFailure(t *testing.T) {
	t.Run("video id", func(t *testing.T) {
		repo, signer := &fakeVideoCreationRepo{}, &fakeUploadPresigner{}
		svc := NewVideoCreationServiceWithDeps(repo, signer, "streaming-video-input", 15*time.Minute, func() time.Time { return testNow }, func() (persistence.CanonicalUUID, error) {
			return "", errors.New("entropy exhausted")
		})
		rr := performValidCreate(svc)
		assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
		if signer.calls != 0 || len(repo.inputs) != 0 {
			t.Fatalf("dependencies called after video id failure: signer=%d repo=%d", signer.calls, len(repo.inputs))
		}
	})
	t.Run("job id", func(t *testing.T) {
		repo, signer := &fakeVideoCreationRepo{}, &fakeUploadPresigner{}
		calls := 0
		svc := NewVideoCreationServiceWithDeps(repo, signer, "streaming-video-input", 15*time.Minute, func() time.Time { return testNow }, func() (persistence.CanonicalUUID, error) {
			calls++
			if calls == 1 {
				return testVideoID, nil
			}
			return "", errors.New("entropy exhausted")
		})
		rr := performValidCreate(svc)
		assertErrorResponse(t, rr, http.StatusInternalServerError, "INTERNAL_ERROR")
		if signer.calls != 0 || len(repo.inputs) != 0 {
			t.Fatalf("dependencies called after job id failure: signer=%d repo=%d", signer.calls, len(repo.inputs))
		}
	})
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

func TestValidateCreateVideoRequestInvalidClasses(t *testing.T) {
	tests := []struct {
		name      string
		req       CreateVideoRequest
		wantField string
	}{
		{name: "valid contract example", req: CreateVideoRequest{FileName: "sample.mp4", ContentType: "video/mp4", SizeBytes: 104857600}},
		{name: "fileName 255", req: CreateVideoRequest{FileName: strings.Repeat("a", 255), ContentType: "video/mp4", SizeBytes: 1}},
		{name: "sizeBytes 1", req: CreateVideoRequest{FileName: "a.mp4", ContentType: "video/mp4", SizeBytes: 1}},
		{name: "sizeBytes 5 GiB", req: CreateVideoRequest{FileName: "a.mp4", ContentType: "video/mp4", SizeBytes: maxSizeBytes}},
		{name: "empty fileName", req: CreateVideoRequest{FileName: "", ContentType: "video/mp4", SizeBytes: 1}, wantField: "fileName"},
		{name: "fileName 256", req: CreateVideoRequest{FileName: strings.Repeat("a", 256), ContentType: "video/mp4", SizeBytes: 1}, wantField: "fileName"},
		{name: "fileName 256 runes", req: CreateVideoRequest{FileName: strings.Repeat("あ", 256), ContentType: "video/mp4", SizeBytes: 1}, wantField: "fileName"},
		{name: "invalid content type", req: CreateVideoRequest{FileName: "a.mp4", ContentType: "video/webm", SizeBytes: 1}, wantField: "contentType"},
		{name: "sizeBytes 0", req: CreateVideoRequest{FileName: "a.mp4", ContentType: "video/mp4", SizeBytes: 0}, wantField: "sizeBytes"},
		{name: "sizeBytes negative", req: CreateVideoRequest{FileName: "a.mp4", ContentType: "video/mp4", SizeBytes: -1}, wantField: "sizeBytes"},
		{name: "sizeBytes over 5 GiB", req: CreateVideoRequest{FileName: "a.mp4", ContentType: "video/mp4", SizeBytes: maxSizeBytes + 1}, wantField: "sizeBytes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateCreateVideoRequest(tt.req)
			if tt.wantField == "" {
				if err != nil {
					t.Fatalf("validateCreateVideoRequest() error = %v", err)
				}
				if utf8.RuneCountInString(tt.req.FileName) > maxFileNameLength {
					t.Fatal("test fixture exceeded fileName max")
				}
				return
			}
			var got *ValidationError
			if !errors.As(err, &got) {
				t.Fatalf("error = %v, want ValidationError", err)
			}
			if got.Field != tt.wantField {
				t.Fatalf("field = %q, want %q", got.Field, tt.wantField)
			}
		})
	}
}

func TestNewCanonicalUUIDIsCanonicalLowercase(t *testing.T) {
	seen := map[persistence.CanonicalUUID]struct{}{}
	for i := 0; i < 64; i++ {
		id, err := newCanonicalUUID()
		if err != nil {
			t.Fatalf("newCanonicalUUID() error = %v", err)
		}
		if !canonicalVideoIDPattern.MatchString(string(id)) {
			t.Fatalf("id = %q, want canonical lowercase UUID", id)
		}
		if string(id)[14] != '4' {
			t.Fatalf("id = %q, want UUID version 4", id)
		}
		switch string(id)[19] {
		case '8', '9', 'a', 'b':
		default:
			t.Fatalf("id = %q, want RFC 4122 variant", id)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = struct{}{}
	}
}

func TestCreateVideoServiceGeneratesCanonicalIDsAndExactKey(t *testing.T) {
	repo := &fakeVideoCreationRepo{}
	signer := &fakeUploadPresigner{result: PresignedUpload{Method: http.MethodPut, URL: "https://example.test/u", Headers: http.Header{"Content-Type": {"video/mp4"}}}}
	svc := NewVideoCreationService(repo, signer, "streaming-video-input")

	got, err := svc.CreateVideo(context.Background(), CreateVideoRequest{FileName: "sample.mp4", ContentType: "video/mp4", SizeBytes: 1})
	if err != nil {
		t.Fatalf("CreateVideo() error = %v", err)
	}
	if !canonicalVideoIDPattern.MatchString(string(got.Video.VideoID)) || !canonicalVideoIDPattern.MatchString(string(got.Video.Job.JobID)) {
		t.Fatalf("generated ids = %q %q", got.Video.VideoID, got.Video.Job.JobID)
	}
	if got.Video.VideoID == got.Video.Job.JobID {
		t.Fatal("video and job IDs must be distinct")
	}
	wantKey := "videos/" + string(got.Video.VideoID) + "/jobs/" + string(got.Video.Job.JobID) + "/source.mp4"
	if got.Video.Upload.Key != wantKey || signer.key != wantKey {
		t.Fatalf("key = %q, want %q", got.Video.Upload.Key, wantKey)
	}
	if strings.Contains(wantKey, "sample.mp4") {
		t.Fatal("canonical key included the client file name")
	}
}

func TestBuildUploadKeyMatchesStorageContract(t *testing.T) {
	got := buildUploadKey(testVideoID, testJobID)
	want := "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4"
	if got != want {
		t.Fatalf("buildUploadKey() = %q, want %q", got, want)
	}
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

func readContractExample(t *testing.T, name string) []byte {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "contracts", "examples", "api", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}

func assertJSONKeysMatch(t *testing.T, gotJSON, wantJSON []byte, path string) {
	t.Helper()
	var got, want any
	if err := json.Unmarshal(gotJSON, &got); err != nil {
		t.Fatalf("unmarshal got: %v", err)
	}
	if err := json.Unmarshal(wantJSON, &want); err != nil {
		t.Fatalf("unmarshal want: %v", err)
	}
	assertJSONKeys(t, got, want, path)
}

func assertJSONKeys(t *testing.T, got, want any, path string) {
	t.Helper()
	wantObj, ok := want.(map[string]any)
	if !ok {
		return
	}
	gotObj, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("%s: got %T, want object", path, got)
	}
	for key := range wantObj {
		if _, ok := gotObj[key]; !ok {
			t.Fatalf("%s: missing key %q", path, key)
		}
	}
	for key := range gotObj {
		if _, ok := wantObj[key]; !ok {
			t.Fatalf("%s: unexpected key %q", path, key)
		}
	}
	for key, wantChild := range wantObj {
		childPath := key
		if path != "" {
			childPath = path + "." + key
		}
		assertJSONKeys(t, gotObj[key], wantChild, childPath)
	}
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
