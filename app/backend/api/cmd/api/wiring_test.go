package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/bootstrap"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/httpapi"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

func TestBuildRuntimeWiresCreateVideoRoute(t *testing.T) {
	db := &fakeDatabase{videos: true, jobs: true}
	server := &capturingServer{}
	var gotRegion, gotBucket string
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
		newRepository: func(databaseHandle) (persistence.Repository, error) { return fakeRepository{}, nil },
		newPresigner: func(_ aws.Config, bucket string) (httpapi.UploadPresigner, error) {
			gotBucket = bucket
			return fakePresigner{}, nil
		},
		newHTTPServer: func(_ string, handler http.Handler) bootstrap.HTTPServer { server.handler = handler; return server },
	}

	_, returnedDB, err := buildRuntime(context.Background(), testConfig(), factories)
	if err != nil {
		t.Fatalf("buildRuntime() error = %v", err)
	}
	if returnedDB != db || !db.pinged {
		t.Fatal("database was not opened and pinged")
	}
	if gotRegion != "ap-northeast-1" {
		t.Fatalf("AWS region = %q", gotRegion)
	}
	if gotBucket != "video-input-test" {
		t.Fatalf("input bucket = %q", gotBucket)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(`{"fileName":"movie.mp4","contentType":"video/mp4","sizeBytes":1}`))
	rec := httptest.NewRecorder()
	server.handler.ServeHTTP(rec, req)
	if rec.Code == http.StatusNotFound {
		t.Fatal("POST /api/v1/videos is not registered")
	}
}

func TestBuildRuntimeFailsBeforeServerAndClosesDatabase(t *testing.T) {
	retrieveErr := errors.New("no credentials")
	tests := []struct {
		name    string
		db      *fakeDatabase
		loadErr error
		awsCfg  aws.Config
	}{
		{name: "connectivity", db: &fakeDatabase{pingErr: errors.New("offline")}},
		{name: "schema", db: &fakeDatabase{videos: true, jobs: false}},
		{name: "aws config", db: &fakeDatabase{videos: true, jobs: true}, loadErr: errors.New("bad aws config")},
		{name: "aws credentials missing", db: &fakeDatabase{videos: true, jobs: true}},
		{
			name:   "aws credentials retrieve",
			db:     &fakeDatabase{videos: true, jobs: true},
			awsCfg: aws.Config{Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) { return aws.Credentials{}, retrieveErr })},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			serverBuilt := false
			factories := runtimeFactories{
				openDatabase: func(string) (databaseHandle, error) { return tt.db, nil },
				loadAWSConfig: func(context.Context, string) (aws.Config, error) {
					return tt.awsCfg, tt.loadErr
				},
				newRepository: func(databaseHandle) (persistence.Repository, error) { return fakeRepository{}, nil },
				newPresigner:  func(aws.Config, string) (httpapi.UploadPresigner, error) { return fakePresigner{}, nil },
				newHTTPServer: func(string, http.Handler) bootstrap.HTTPServer { serverBuilt = true; return &capturingServer{} },
			}
			if _, _, err := buildRuntime(context.Background(), testConfig(), factories); err == nil {
				t.Fatal("buildRuntime() error = nil")
			}
			if serverBuilt {
				t.Fatal("server was built after dependency failure")
			}
			if !tt.db.closed {
				t.Fatal("database was not closed")
			}
		})
	}
}

func testConfig() config.Config {
	return config.Config{HTTPAddr: "127.0.0.1:8080", DatabaseURL: "postgres://db/app", AWSRegion: "ap-northeast-1", InputBucket: "video-input-test"}
}

func testAWSConfig() aws.Config {
	return aws.Config{
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRET", Source: "test"}, nil
		}),
	}
}

type fakeDatabase struct {
	pingErr                      error
	videos, jobs, pinged, closed bool
}

func (d *fakeDatabase) PingContext(context.Context) error { d.pinged = true; return d.pingErr }
func (d *fakeDatabase) RequiredTables(context.Context) (bool, bool, error) {
	return d.videos, d.jobs, nil
}
func (d *fakeDatabase) Close() error { d.closed = true; return nil }

type fakeRepository struct{}

func (fakeRepository) CreateVideo(context.Context, persistence.CreateVideoInput) (persistence.Video, error) {
	return persistence.Video{}, errors.New("fake")
}
func (fakeRepository) GetVideoByID(context.Context, persistence.CanonicalUUID) (persistence.Video, error) {
	return persistence.Video{}, persistence.ErrNotFound
}

type fakePresigner struct{}

func (fakePresigner) PresignUpload(context.Context, string, string, string, time.Duration) (httpapi.PresignedUpload, error) {
	return httpapi.PresignedUpload{}, errors.New("fake")
}

type capturingServer struct{ handler http.Handler }

func (*capturingServer) ListenAndServe() error          { return nil }
func (*capturingServer) Shutdown(context.Context) error { return nil }
