package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/bootstrap"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/httpapi"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

const dependencyCheckTimeout = 10 * time.Second

type databaseHandle interface {
	PingContext(context.Context) error
	RequiredTables(context.Context) (bool, bool, error)
	Close() error
}

type postgresDatabase struct{ db *sql.DB }

func (d *postgresDatabase) PingContext(ctx context.Context) error { return d.db.PingContext(ctx) }
func (d *postgresDatabase) Close() error                          { return d.db.Close() }
func (d *postgresDatabase) RequiredTables(ctx context.Context) (bool, bool, error) {
	var videos, jobs *string
	err := d.db.QueryRowContext(ctx, `SELECT to_regclass('videos')::text, to_regclass('jobs')::text`).Scan(&videos, &jobs)
	return videos != nil, jobs != nil, err
}

type runtimeFactories struct {
	openDatabase  func(string) (databaseHandle, error)
	loadAWSConfig func(context.Context, string) (aws.Config, error)
	newRepository func(databaseHandle) (persistence.Repository, error)
	newPresigner  func(aws.Config, string) (httpapi.UploadPresigner, error)
	newHTTPServer func(string, http.Handler) bootstrap.HTTPServer
}

func defaultRuntimeFactories() runtimeFactories {
	return runtimeFactories{
		openDatabase: func(databaseURL string) (databaseHandle, error) {
			db, err := sql.Open("pgx", databaseURL)
			if err != nil {
				return nil, err
			}
			return &postgresDatabase{db: db}, nil
		},
		loadAWSConfig: func(ctx context.Context, region string) (aws.Config, error) {
			return awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
		},
		newRepository: func(db databaseHandle) (persistence.Repository, error) {
			postgresDB, ok := db.(*postgresDatabase)
			if !ok {
				return nil, errors.New("postgres database handle has an unexpected type")
			}
			return persistence.NewPostgresRepository(postgresDB.db), nil
		},
		newPresigner: func(cfg aws.Config, bucket string) (httpapi.UploadPresigner, error) {
			if bucket == "" {
				return nil, errors.New("video input bucket is required")
			}
			client := s3.NewPresignClient(s3.NewFromConfig(cfg))
			return httpapi.NewS3UploadPresigner(&s3PresignAdapter{client: client}, bucket), nil
		},
		newHTTPServer: func(addr string, handler http.Handler) bootstrap.HTTPServer {
			return &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: readHeaderTimeout, ReadTimeout: readTimeout, WriteTimeout: writeTimeout, IdleTimeout: idleTimeout}
		},
	}
}

func buildRuntime(ctx context.Context, cfg config.Config, factories runtimeFactories) (*bootstrap.Runtime, databaseHandle, error) {
	if factories.openDatabase == nil || factories.loadAWSConfig == nil || factories.newRepository == nil || factories.newPresigner == nil || factories.newHTTPServer == nil {
		return nil, nil, errors.New("runtime dependency factories are required")
	}

	db, err := factories.openDatabase(cfg.DatabaseURL)
	if err != nil {
		return nil, nil, fmt.Errorf("open postgres: %w", err)
	}
	if db == nil {
		return nil, nil, errors.New("open postgres: database handle is nil")
	}
	ok := false
	defer func() {
		if !ok {
			_ = db.Close()
		}
	}()

	checkCtx, cancel := context.WithTimeout(ctx, dependencyCheckTimeout)
	defer cancel()
	if err := db.PingContext(checkCtx); err != nil {
		return nil, nil, fmt.Errorf("verify postgres connectivity: %w", err)
	}
	if err := verifySchema(checkCtx, db); err != nil {
		return nil, nil, fmt.Errorf("verify postgres schema: %w", err)
	}

	awsCfg, err := factories.loadAWSConfig(checkCtx, cfg.AWSRegion)
	if err != nil {
		return nil, nil, fmt.Errorf("load AWS configuration: %w", err)
	}
	if err := verifyAWSCredentials(checkCtx, awsCfg); err != nil {
		return nil, nil, fmt.Errorf("retrieve AWS credentials: %w", err)
	}
	repo, err := factories.newRepository(db)
	if err != nil || repo == nil {
		if err == nil {
			err = errors.New("repository is nil")
		}
		return nil, nil, fmt.Errorf("construct postgres repository: %w", err)
	}
	presigner, err := factories.newPresigner(awsCfg, cfg.InputBucket)
	if err != nil || presigner == nil {
		if err == nil {
			err = errors.New("presigner is nil")
		}
		return nil, nil, fmt.Errorf("construct S3 presigner: %w", err)
	}

	service := httpapi.NewVideoCreationService(repo, presigner, cfg.InputBucket)
	status := httpapi.NewVideoStatusService(repo)
	server := factories.newHTTPServer(cfg.HTTPAddr, httpapi.NewRouterWithServices(service, status))
	if server == nil {
		return nil, nil, errors.New("construct HTTP server: server is nil")
	}
	ok = true
	return bootstrap.New(cfg, bootstrap.Dependencies{Server: server}), db, nil
}

func verifyAWSCredentials(ctx context.Context, cfg aws.Config) error {
	if cfg.Credentials == nil {
		return errors.New("AWS credentials provider is required")
	}
	if _, err := cfg.Credentials.Retrieve(ctx); err != nil {
		return err
	}
	return nil
}

func verifySchema(ctx context.Context, db databaseHandle) error {
	videos, jobs, err := db.RequiredTables(ctx)
	if err != nil {
		return err
	}
	if !videos || !jobs {
		return errors.New("required tables videos and jobs are not available; apply the Phase 1 migration")
	}
	return nil
}

type s3PresignAPI interface {
	PresignPutObject(context.Context, *s3.PutObjectInput, ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
}

type s3PresignAdapter struct{ client s3PresignAPI }

func (a *s3PresignAdapter) PresignPutObject(ctx context.Context, input httpapi.S3PutObjectInput) (httpapi.S3PresignResult, error) {
	result, err := a.client.PresignPutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(input.Bucket), Key: aws.String(input.Key), ContentType: aws.String(input.ContentType)}, func(options *s3.PresignOptions) {
		options.Expires = input.Expires
	})
	if err != nil {
		return httpapi.S3PresignResult{}, err
	}
	return httpapi.S3PresignResult{URL: result.URL, Headers: result.SignedHeader}, nil
}
