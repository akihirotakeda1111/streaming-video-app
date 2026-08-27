package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/bootstrap"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/httpapi"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

func TestBuildRuntimeWiresContractRoutes(t *testing.T) {
	db := &fakeDatabase{videos: true, jobs: true}
	server := &capturingServer{}
	var gotRegion, gotBucket, gotAddr string
	repo := fakeRepository{video: completedContractVideo()}
	factories := runtimeFactories{
		openDatabase: func(url string) (databaseHandle, error) {
			if url != "postgres://db/app" {
				t.Fatalf("database URL = %q", url)
			}
			return db, nil
		},
		loadAWSConfig: func(_ context.Context, region string) (aws.Config, error) {
			gotRegion = region
			return testAWSConfig(), nil
		},
		newRepository: func(databaseHandle) (persistence.Repository, error) { return repo, nil },
		newPresigner: func(_ aws.Config, bucket string) (httpapi.UploadPresigner, error) {
			gotBucket = bucket
			return fakePresigner{}, nil
		},
		newHTTPServer: func(addr string, handler http.Handler) bootstrap.HTTPServer {
			gotAddr = addr
			server.handler = handler
			return server
		},
	}

	_, returnedDB, err := buildRuntime(context.Background(), testConfig(), factories)
	if err != nil {
		t.Fatalf("buildRuntime() error = %v", err)
	}
	if returnedDB != db || !db.pinged {
		t.Fatal("database was not opened and pinged")
	}
	if db.closed {
		t.Fatal("database was closed after successful wiring")
	}
	if gotRegion != "ap-northeast-1" {
		t.Fatalf("AWS region = %q", gotRegion)
	}
	if gotBucket != "video-input-test" {
		t.Fatalf("input bucket = %q", gotBucket)
	}
	if gotAddr != "127.0.0.1:8080" {
		t.Fatalf("HTTP addr = %q", gotAddr)
	}

	assertRouteStatus(t, server.handler, http.MethodGet, "/api/v1/health", http.StatusOK)

	post := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(`{"fileName":"movie.mp4","contentType":"video/mp4","sizeBytes":1}`))
	postRec := httptest.NewRecorder()
	server.handler.ServeHTTP(postRec, post)
	if postRec.Code == http.StatusNotFound {
		t.Fatal("POST /api/v1/videos is not registered")
	}

	statusRec := serve(server.handler, http.MethodGet, "/api/v1/videos/"+string(testContractVideoID))
	if statusRec.Code != http.StatusOK {
		t.Fatalf("GET video status = %d, body = %s", statusRec.Code, statusRec.Body.String())
	}
	var statusBody map[string]any
	if err := json.Unmarshal(statusRec.Body.Bytes(), &statusBody); err != nil {
		t.Fatal(err)
	}
	if statusBody["videoId"] != string(testContractVideoID) {
		t.Fatalf("status videoId = %#v", statusBody["videoId"])
	}

	playbackRec := serve(server.handler, http.MethodGet, "/api/v1/videos/"+string(testContractVideoID)+"/playback")
	if playbackRec.Code != http.StatusOK {
		t.Fatalf("GET playback = %d, body = %s", playbackRec.Code, playbackRec.Body.String())
	}
	var playbackBody map[string]any
	if err := json.Unmarshal(playbackRec.Body.Bytes(), &playbackBody); err != nil {
		t.Fatal(err)
	}
	if playbackBody["protocol"] != "HLS" || playbackBody["contentType"] != "application/vnd.apple.mpegurl" {
		t.Fatalf("playback = %#v", playbackBody)
	}
	wantURL := "https://video-output-test.s3.ap-northeast-1.amazonaws.com/videos/" + string(testContractVideoID) + "/jobs/" + string(testContractJobID) + "/hls/index.m3u8"
	if playbackBody["manifestUrl"] != wantURL {
		t.Fatalf("manifestUrl = %#v, want %q", playbackBody["manifestUrl"], wantURL)
	}

	invalid := serve(server.handler, http.MethodGet, "/api/v1/videos/not-a-uuid")
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid status videoId = %d, want 400 (route missing would be 404)", invalid.Code)
	}
	invalidPlayback := serve(server.handler, http.MethodGet, "/api/v1/videos/not-a-uuid/playback")
	if invalidPlayback.Code != http.StatusBadRequest {
		t.Fatalf("invalid playback videoId = %d, want 400 (route missing would be 404)", invalidPlayback.Code)
	}
}

func TestBuildRuntimeFailsBeforeServerAndClosesDatabase(t *testing.T) {
	retrieveErr := errors.New("no credentials")
	tests := []struct {
		name        string
		db          *fakeDatabase
		openErr     error
		openNil     bool
		loadErr     error
		awsCfg      aws.Config
		repoErr     error
		repoNil     bool
		presignErr  error
		presignNil  bool
		serverNil   bool
		wantBuilt   bool
		wantClosed  bool
		wantContain string
	}{
		{name: "connectivity", db: &fakeDatabase{pingErr: errors.New("offline")}, wantClosed: true, wantContain: "verify postgres connectivity"},
		{name: "schema", db: &fakeDatabase{videos: true, jobs: false}, wantClosed: true, wantContain: "verify postgres schema"},
		{name: "schema query", db: &fakeDatabase{videos: true, jobs: true, tablesErr: errors.New("catalog unavailable")}, wantClosed: true, wantContain: "verify postgres schema"},
		{name: "aws config", db: &fakeDatabase{videos: true, jobs: true}, loadErr: errors.New("bad aws config"), wantClosed: true, wantContain: "load AWS configuration"},
		{name: "aws credentials missing", db: &fakeDatabase{videos: true, jobs: true}, wantClosed: true, wantContain: "retrieve AWS credentials"},
		{
			name:        "aws credentials retrieve",
			db:          &fakeDatabase{videos: true, jobs: true},
			awsCfg:      aws.Config{Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) { return aws.Credentials{}, retrieveErr })},
			wantClosed:  true,
			wantContain: "retrieve AWS credentials",
		},
		{name: "open database", openErr: errors.New("refused"), wantContain: "open postgres"},
		{name: "open database nil", openNil: true, wantContain: "database handle is nil"},
		{name: "repository error", db: &fakeDatabase{videos: true, jobs: true}, awsCfg: testAWSConfig(), repoErr: errors.New("repo failed"), wantClosed: true, wantContain: "construct postgres repository"},
		{name: "repository nil", db: &fakeDatabase{videos: true, jobs: true}, awsCfg: testAWSConfig(), repoNil: true, wantClosed: true, wantContain: "construct postgres repository"},
		{name: "presigner error", db: &fakeDatabase{videos: true, jobs: true}, awsCfg: testAWSConfig(), presignErr: errors.New("signer failed"), wantClosed: true, wantContain: "construct S3 presigner"},
		{name: "presigner nil", db: &fakeDatabase{videos: true, jobs: true}, awsCfg: testAWSConfig(), presignNil: true, wantClosed: true, wantContain: "construct S3 presigner"},
		{name: "server nil", db: &fakeDatabase{videos: true, jobs: true}, awsCfg: testAWSConfig(), serverNil: true, wantBuilt: true, wantClosed: true, wantContain: "construct HTTP server"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			serverBuilt := false
			factories := runtimeFactories{
				openDatabase: func(string) (databaseHandle, error) {
					if tt.openErr != nil {
						return nil, tt.openErr
					}
					if tt.openNil {
						return nil, nil
					}
					return tt.db, nil
				},
				loadAWSConfig: func(context.Context, string) (aws.Config, error) {
					return tt.awsCfg, tt.loadErr
				},
				newRepository: func(databaseHandle) (persistence.Repository, error) {
					if tt.repoErr != nil {
						return nil, tt.repoErr
					}
					if tt.repoNil {
						return nil, nil
					}
					return fakeRepository{}, nil
				},
				newPresigner: func(aws.Config, string) (httpapi.UploadPresigner, error) {
					if tt.presignErr != nil {
						return nil, tt.presignErr
					}
					if tt.presignNil {
						return nil, nil
					}
					return fakePresigner{}, nil
				},
				newHTTPServer: func(string, http.Handler) bootstrap.HTTPServer {
					serverBuilt = true
					if tt.serverNil {
						return nil
					}
					return &capturingServer{}
				},
			}
			if _, _, err := buildRuntime(context.Background(), testConfig(), factories); err == nil {
				t.Fatal("buildRuntime() error = nil")
			} else if tt.wantContain != "" && !strings.Contains(err.Error(), tt.wantContain) {
				t.Fatalf("error = %q, want substring %q", err, tt.wantContain)
			}
			if serverBuilt != tt.wantBuilt {
				t.Fatalf("server built = %v, want %v", serverBuilt, tt.wantBuilt)
			}
			if tt.wantClosed && (tt.db == nil || !tt.db.closed) {
				t.Fatal("database was not closed")
			}
		})
	}
}

func TestBuildRuntimeRequiresFactories(t *testing.T) {
	_, _, err := buildRuntime(context.Background(), testConfig(), runtimeFactories{})
	if err == nil {
		t.Fatal("buildRuntime() error = nil")
	}
	if !strings.Contains(err.Error(), "runtime dependency factories are required") {
		t.Fatalf("error = %q", err)
	}
}

func TestRunStartsAndClosesDatabaseOnShutdown(t *testing.T) {
	db := &fakeDatabase{videos: true, jobs: true}
	server := newBlockingServer()
	errCh := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		errCh <- run(ctx, testLookupEnv(), runtimeFactories{
			openDatabase:  func(string) (databaseHandle, error) { return db, nil },
			loadAWSConfig: func(context.Context, string) (aws.Config, error) { return testAWSConfig(), nil },
			newRepository: func(databaseHandle) (persistence.Repository, error) { return fakeRepository{}, nil },
			newPresigner:  func(aws.Config, string) (httpapi.UploadPresigner, error) { return fakePresigner{}, nil },
			newHTTPServer: func(string, http.Handler) bootstrap.HTTPServer { return server },
		})
	}()

	select {
	case <-server.listenStarted:
	case err := <-errCh:
		t.Fatalf("run() returned before listen: %v", err)
	case <-time.After(time.Second):
		t.Fatal("run() did not start the HTTP server")
	}
	if db.closed {
		t.Fatal("database closed before shutdown")
	}

	cancel()

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("run() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("run() did not return after shutdown")
	}
	if !db.closed {
		t.Fatal("database was not closed after run() returned")
	}
}

func TestRunReturnsConfigAndRuntimeErrors(t *testing.T) {
	t.Run("config", func(t *testing.T) {
		err := run(context.Background(), func(string) (string, bool) { return "", false }, defaultRuntimeFactories())
		if err == nil {
			t.Fatal("run() error = nil, want config failure")
		}
	})
	t.Run("runtime", func(t *testing.T) {
		db := &fakeDatabase{pingErr: errors.New("offline")}
		err := run(context.Background(), testLookupEnv(), runtimeFactories{
			openDatabase:  func(string) (databaseHandle, error) { return db, nil },
			loadAWSConfig: func(context.Context, string) (aws.Config, error) { return testAWSConfig(), nil },
			newRepository: func(databaseHandle) (persistence.Repository, error) { return fakeRepository{}, nil },
			newPresigner:  func(aws.Config, string) (httpapi.UploadPresigner, error) { return fakePresigner{}, nil },
			newHTTPServer: func(string, http.Handler) bootstrap.HTTPServer {
				t.Fatal("server must not be built")
				return &capturingServer{}
			},
		})
		if err == nil {
			t.Fatal("run() error = nil, want runtime failure")
		}
		if !db.closed {
			t.Fatal("database was not closed after runtime failure")
		}
	})
}

func TestDefaultRuntimeFactories(t *testing.T) {
	factories := defaultRuntimeFactories()
	if factories.openDatabase == nil || factories.loadAWSConfig == nil || factories.newRepository == nil || factories.newPresigner == nil || factories.newHTTPServer == nil {
		t.Fatal("defaultRuntimeFactories() returned a nil factory")
	}

	handler := http.NewServeMux()
	srv, ok := factories.newHTTPServer("127.0.0.1:8080", handler).(*http.Server)
	if !ok {
		t.Fatal("newHTTPServer did not return *http.Server")
	}
	if srv.Addr != "127.0.0.1:8080" || srv.Handler != handler {
		t.Fatalf("HTTP server = %#v", srv)
	}
	if srv.ReadHeaderTimeout != readHeaderTimeout || srv.ReadTimeout != readTimeout || srv.WriteTimeout != writeTimeout || srv.IdleTimeout != idleTimeout {
		t.Fatalf("timeouts = header:%v read:%v write:%v idle:%v", srv.ReadHeaderTimeout, srv.ReadTimeout, srv.WriteTimeout, srv.IdleTimeout)
	}

	db, err := factories.openDatabase("postgres://streaming_video:pass@127.0.0.1:1/streaming_video?sslmode=disable")
	if err != nil {
		t.Fatalf("openDatabase() error = %v", err)
	}
	pg, ok := db.(*postgresDatabase)
	if !ok || pg.db == nil {
		t.Fatalf("openDatabase() type = %T", db)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err == nil {
		t.Fatal("PingContext() error = nil, want connectivity failure")
	}
	if _, _, err := db.RequiredTables(ctx); err == nil {
		t.Fatal("RequiredTables() error = nil, want query failure")
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	repo, err := factories.newRepository(pg)
	if err != nil || repo == nil {
		t.Fatalf("newRepository() = %v, %v", repo, err)
	}
	if _, err := factories.newRepository(&fakeDatabase{}); err == nil {
		t.Fatal("newRepository() accepted a non-postgres handle")
	}

	presigner, err := factories.newPresigner(aws.Config{Region: "ap-northeast-1"}, "video-input-test")
	if err != nil || presigner == nil {
		t.Fatalf("newPresigner() = %v, %v", presigner, err)
	}
	if _, err := factories.newPresigner(aws.Config{Region: "ap-northeast-1"}, ""); err == nil {
		t.Fatal("newPresigner() accepted an empty bucket")
	}

	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_ACCESS_KEY_ID", "testing")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "testing")
	awsCfg, err := factories.loadAWSConfig(context.Background(), "ap-northeast-1")
	if err != nil {
		t.Fatalf("loadAWSConfig() error = %v", err)
	}
	if awsCfg.Region != "ap-northeast-1" {
		t.Fatalf("loadAWSConfig() region = %q", awsCfg.Region)
	}
}

func TestS3PresignAdapterForwardsPutObjectInput(t *testing.T) {
	api := &recordingS3PresignAPI{
		result: &v4.PresignedHTTPRequest{
			URL:          "https://example.invalid/put?X-Amz-Signature=test",
			SignedHeader: http.Header{"Content-Type": []string{"video/mp4"}},
		},
	}
	adapter := &s3PresignAdapter{client: api}
	got, err := adapter.PresignPutObject(context.Background(), httpapi.S3PutObjectInput{
		Bucket:      "video-input-test",
		Key:         "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4",
		ContentType: "video/mp4",
		Expires:     15 * time.Minute,
	})
	if err != nil {
		t.Fatalf("PresignPutObject() error = %v", err)
	}
	if aws.ToString(api.input.Bucket) != "video-input-test" {
		t.Fatalf("Bucket = %q", aws.ToString(api.input.Bucket))
	}
	if aws.ToString(api.input.Key) != "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4" {
		t.Fatalf("Key = %q", aws.ToString(api.input.Key))
	}
	if aws.ToString(api.input.ContentType) != "video/mp4" {
		t.Fatalf("ContentType = %q", aws.ToString(api.input.ContentType))
	}
	if api.expires != 15*time.Minute {
		t.Fatalf("Expires = %v, want 15m", api.expires)
	}
	if got.URL != api.result.URL {
		t.Fatalf("URL = %q", got.URL)
	}
	if got.Headers.Get("Content-Type") != "video/mp4" {
		t.Fatalf("headers = %v", got.Headers)
	}
}

func TestS3PresignAdapterPropagatesError(t *testing.T) {
	want := errors.New("presign failed")
	adapter := &s3PresignAdapter{client: &recordingS3PresignAPI{err: want}}
	_, err := adapter.PresignPutObject(context.Background(), httpapi.S3PutObjectInput{
		Bucket:      "video-input-test",
		Key:         "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4",
		ContentType: "video/mp4",
		Expires:     time.Minute,
	})
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

var (
	testContractVideoID = persistence.CanonicalUUID("018f47a2-45c2-7a84-b84f-5f6dd7b5910a")
	testContractJobID   = persistence.CanonicalUUID("018f47a2-4699-7892-9fc0-fbe46d3bbd67")
)

func completedContractVideo() persistence.Video {
	createdAt := time.Date(2026, time.August, 25, 3, 0, 0, 0, time.UTC)
	return persistence.Video{
		VideoID:     testContractVideoID,
		FileName:    "sample.mp4",
		ContentType: "video/mp4",
		SizeBytes:   104857600,
		Job: persistence.EncodingJob{
			JobID:     testContractJobID,
			VideoID:   testContractVideoID,
			Status:    persistence.JobStatusCompleted,
			UpdatedAt: createdAt.Add(4*time.Minute + 52*time.Second),
		},
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}
}

func testConfig() config.Config {
	return config.Config{
		HTTPAddr:         "127.0.0.1:8080",
		DatabaseURL:      "postgres://db/app",
		AWSRegion:        "ap-northeast-1",
		InputBucket:      "video-input-test",
		OutputBucket:     "video-output-test",
		OutputS3Endpoint: "https://video-output-test.s3.ap-northeast-1.amazonaws.com",
	}
}

func testLookupEnv() config.LookupEnvFunc {
	cfg := testConfig()
	values := map[string]string{
		"HTTP_ADDR":           cfg.HTTPAddr,
		"DATABASE_URL":        cfg.DatabaseURL,
		"AWS_REGION":          cfg.AWSRegion,
		"VIDEO_INPUT_BUCKET":  cfg.InputBucket,
		"VIDEO_OUTPUT_BUCKET": cfg.OutputBucket,
		"OUTPUT_S3_ENDPOINT":  cfg.OutputS3Endpoint,
	}
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}

func testAWSConfig() aws.Config {
	return aws.Config{
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRET", Source: "test"}, nil
		}),
	}
}

func serve(handler http.Handler, method, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

func assertRouteStatus(t *testing.T, handler http.Handler, method, path string, want int) {
	t.Helper()
	rec := serve(handler, method, path)
	if rec.Code != want {
		t.Fatalf("%s %s status = %d, want %d, body = %s", method, path, rec.Code, want, rec.Body.String())
	}
}

type fakeDatabase struct {
	pingErr                      error
	tablesErr                    error
	videos, jobs, pinged, closed bool
}

func (d *fakeDatabase) PingContext(context.Context) error { d.pinged = true; return d.pingErr }
func (d *fakeDatabase) RequiredTables(context.Context) (bool, bool, error) {
	return d.videos, d.jobs, d.tablesErr
}
func (d *fakeDatabase) Close() error { d.closed = true; return nil }

type fakeRepository struct {
	video persistence.Video
}

func (r fakeRepository) CreateVideo(context.Context, persistence.CreateVideoInput) (persistence.Video, error) {
	return persistence.Video{}, errors.New("fake")
}
func (r fakeRepository) GetVideoByID(context.Context, persistence.CanonicalUUID) (persistence.Video, error) {
	if r.video.VideoID == "" {
		return persistence.Video{}, persistence.ErrNotFound
	}
	return r.video, nil
}

type fakePresigner struct{}

func (fakePresigner) PresignUpload(context.Context, string, string, string, time.Duration) (httpapi.PresignedUpload, error) {
	return httpapi.PresignedUpload{}, errors.New("fake")
}

type capturingServer struct{ handler http.Handler }

func (*capturingServer) ListenAndServe() error          { return nil }
func (*capturingServer) Shutdown(context.Context) error { return nil }

type blockingServer struct {
	listenStarted  chan struct{}
	shutdownCalled chan struct{}
	once           sync.Once
}

func newBlockingServer() *blockingServer {
	return &blockingServer{
		listenStarted:  make(chan struct{}),
		shutdownCalled: make(chan struct{}),
	}
}

func (s *blockingServer) ListenAndServe() error {
	close(s.listenStarted)
	<-s.shutdownCalled
	return http.ErrServerClosed
}

func (s *blockingServer) Shutdown(context.Context) error {
	s.once.Do(func() { close(s.shutdownCalled) })
	return nil
}

type recordingS3PresignAPI struct {
	input   *s3.PutObjectInput
	expires time.Duration
	result  *v4.PresignedHTTPRequest
	err     error
}

func (r *recordingS3PresignAPI) PresignPutObject(_ context.Context, input *s3.PutObjectInput, optFns ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	r.input = input
	options := &s3.PresignOptions{}
	for _, fn := range optFns {
		fn(options)
	}
	r.expires = options.Expires
	return r.result, r.err
}
