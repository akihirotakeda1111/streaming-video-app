package config

import "testing"

func TestLoadConfigValid(t *testing.T) {
	cfg, err := Load(lookupEnvFromMap(map[string]string{
		envHTTPAddr:    "0.0.0.0:8080",
		envDatabaseURL: "postgres://user:pass@localhost:5432/app?sslmode=disable",
		envAWSRegion:   "ap-northeast-1",
		envVideoInput:  "streaming-video-input-dev",
		envVideoOutput: "streaming-video-output-dev",
		envOutputS3:    "http://localhost:4566",
		envFrontend:    "http://localhost:5173",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.HTTPAddr != "0.0.0.0:8080" {
		t.Fatalf("HTTPAddr = %q, want %q", cfg.HTTPAddr, "0.0.0.0:8080")
	}
	if cfg.DatabaseURL != "postgres://user:pass@localhost:5432/app?sslmode=disable" {
		t.Fatalf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	if cfg.AWSRegion != "ap-northeast-1" {
		t.Fatalf("AWSRegion = %q", cfg.AWSRegion)
	}
	if cfg.InputBucket != "streaming-video-input-dev" {
		t.Fatalf("InputBucket = %q, want %q", cfg.InputBucket, "streaming-video-input-dev")
	}
	if cfg.OutputBucket != "streaming-video-output-dev" {
		t.Fatalf("OutputBucket = %q, want %q", cfg.OutputBucket, "streaming-video-output-dev")
	}
	if cfg.OutputS3Endpoint != "http://localhost:4566" {
		t.Fatalf("OutputS3Endpoint = %q", cfg.OutputS3Endpoint)
	}
	if cfg.FrontendOrigin != "http://localhost:5173" {
		t.Fatalf("FrontendOrigin = %q", cfg.FrontendOrigin)
	}
}

func TestLoadConfigMissingRequiredValue(t *testing.T) {
	required := []string{
		envHTTPAddr,
		envDatabaseURL,
		envAWSRegion,
		envVideoInput,
		envVideoOutput,
		envOutputS3,
		envFrontend,
	}

	for _, name := range required {
		t.Run(name, func(t *testing.T) {
			env := map[string]string{
				envHTTPAddr:    "0.0.0.0:8080",
				envDatabaseURL: "postgres://user:pass@localhost:5432/app?sslmode=disable",
				envAWSRegion:   "ap-northeast-1",
				envVideoInput:  "streaming-video-input-dev",
				envVideoOutput: "streaming-video-output-dev",
				envOutputS3:    "http://localhost:4566",
				envFrontend:    "http://localhost:5173",
			}
			delete(env, name)

			_, err := Load(lookupEnvFromMap(env))
			if err == nil {
				t.Fatalf("Load() error = nil, want failure for %s", name)
			}
			if got := err.Error(); got == "" {
				t.Fatalf("Load() error string is empty")
			}
		})
	}
}

func TestLoadConfigRejectsMalformedValues(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad_http_addr",
			env: map[string]string{
				envHTTPAddr:    "localhost",
				envDatabaseURL: "postgres://user:pass@localhost:5432/app?sslmode=disable",
				envAWSRegion:   "ap-northeast-1",
				envVideoInput:  "streaming-video-input-dev",
				envVideoOutput: "streaming-video-output-dev",
				envOutputS3:    "http://localhost:4566",
				envFrontend:    "http://localhost:5173",
			},
		},
		{
			name: "bad_database_url",
			env: map[string]string{
				envHTTPAddr:    "0.0.0.0:8080",
				envDatabaseURL: "postgres://",
				envAWSRegion:   "ap-northeast-1",
				envVideoInput:  "streaming-video-input-dev",
				envVideoOutput: "streaming-video-output-dev",
				envOutputS3:    "http://localhost:4566",
				envFrontend:    "http://localhost:5173",
			},
		},
		{
			name: "same_buckets",
			env: map[string]string{
				envHTTPAddr:    "0.0.0.0:8080",
				envDatabaseURL: "postgres://user:pass@localhost:5432/app?sslmode=disable",
				envAWSRegion:   "ap-northeast-1",
				envVideoInput:  "streaming-video-dev",
				envVideoOutput: "streaming-video-dev",
				envOutputS3:    "http://localhost:4566",
				envFrontend:    "http://localhost:5173",
			},
		},
		{
			name: "ip_form_bucket",
			env: map[string]string{
				envHTTPAddr:    "0.0.0.0:8080",
				envDatabaseURL: "postgres://user:pass@localhost:5432/app?sslmode=disable",
				envAWSRegion:   "ap-northeast-1",
				envVideoInput:  "192.168.5.4",
				envVideoOutput: "streaming-video-output-dev",
				envOutputS3:    "http://localhost:4566",
				envFrontend:    "http://localhost:5173",
			},
		},
		{
			name: "bad_database_url_scheme",
			env: map[string]string{
				envHTTPAddr:    "0.0.0.0:8080",
				envDatabaseURL: "http://localhost:5432/app",
				envAWSRegion:   "ap-northeast-1",
				envVideoInput:  "streaming-video-input-dev",
				envVideoOutput: "streaming-video-output-dev",
				envOutputS3:    "http://localhost:4566",
				envFrontend:    "http://localhost:5173",
			},
		},
		{
			name: "bad_s3_endpoint_scheme",
			env: map[string]string{
				envHTTPAddr:    "0.0.0.0:8080",
				envDatabaseURL: "postgres://user:pass@localhost:5432/app?sslmode=disable",
				envAWSRegion:   "ap-northeast-1",
				envVideoInput:  "streaming-video-input-dev",
				envVideoOutput: "streaming-video-output-dev",
				envOutputS3:    "ftp://localhost:4566",
				envFrontend:    "http://localhost:5173",
			},
		},
		{
			name: "frontend_origin_with_path",
			env: map[string]string{
				envHTTPAddr:    "0.0.0.0:8080",
				envDatabaseURL: "postgres://user:pass@localhost:5432/app?sslmode=disable",
				envAWSRegion:   "ap-northeast-1",
				envVideoInput:  "streaming-video-input-dev",
				envVideoOutput: "streaming-video-output-dev",
				envOutputS3:    "http://localhost:4566",
				envFrontend:    "http://localhost:5173/not-an-origin",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Load(lookupEnvFromMap(tc.env)); err == nil {
				t.Fatalf("Load() error = nil, want failure")
			}
		})
	}
}

func lookupEnvFromMap(values map[string]string) LookupEnvFunc {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}
