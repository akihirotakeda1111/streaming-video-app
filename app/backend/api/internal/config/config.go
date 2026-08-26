package config

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	envHTTPAddr    = "HTTP_ADDR"
	envDatabaseURL = "DATABASE_URL"
	envAWSRegion   = "AWS_REGION"
	envVideoInput  = "VIDEO_INPUT_BUCKET"
	envVideoOutput = "VIDEO_OUTPUT_BUCKET"
	envOutputS3    = "OUTPUT_S3_ENDPOINT"
)

var s3BucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

type LookupEnvFunc func(string) (string, bool)

type Config struct {
	HTTPAddr         string
	DatabaseURL      string
	AWSRegion        string
	InputBucket      string
	OutputBucket     string
	OutputS3Endpoint string
}

func Load(lookupEnv LookupEnvFunc) (Config, error) {
	cfg := Config{}

	if err := loadRequiredString(lookupEnv, envHTTPAddr, &cfg.HTTPAddr); err != nil {
		return Config{}, err
	}
	if err := validateHTTPAddr(cfg.HTTPAddr); err != nil {
		return Config{}, wrapInvalid(envHTTPAddr, err)
	}

	if err := loadRequiredString(lookupEnv, envDatabaseURL, &cfg.DatabaseURL); err != nil {
		return Config{}, err
	}
	if err := validateDatabaseURL(cfg.DatabaseURL); err != nil {
		return Config{}, wrapInvalid(envDatabaseURL, err)
	}

	if err := loadRequiredString(lookupEnv, envAWSRegion, &cfg.AWSRegion); err != nil {
		return Config{}, err
	}

	if err := loadRequiredString(lookupEnv, envVideoInput, &cfg.InputBucket); err != nil {
		return Config{}, err
	}
	if err := validateS3Bucket(cfg.InputBucket); err != nil {
		return Config{}, wrapInvalid(envVideoInput, err)
	}

	if err := loadRequiredString(lookupEnv, envVideoOutput, &cfg.OutputBucket); err != nil {
		return Config{}, err
	}
	if err := validateS3Bucket(cfg.OutputBucket); err != nil {
		return Config{}, wrapInvalid(envVideoOutput, err)
	}

	if cfg.InputBucket == cfg.OutputBucket {
		return Config{}, fmt.Errorf("environment variable %q must differ from %q", envVideoInput, envVideoOutput)
	}

	if err := loadRequiredString(lookupEnv, envOutputS3, &cfg.OutputS3Endpoint); err != nil {
		return Config{}, err
	}
	if err := validateS3EndpointURL(cfg.OutputS3Endpoint); err != nil {
		return Config{}, wrapInvalid(envOutputS3, err)
	}

	return cfg, nil
}

func loadRequiredString(lookupEnv LookupEnvFunc, name string, target *string) error {
	value, ok := lookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fmt.Errorf("environment variable %q is required", name)
	}

	*target = strings.TrimSpace(value)
	return nil
}

func validateHTTPAddr(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("must be in host:port form")
	}
	_ = host

	portNum, err := strconv.Atoi(port)
	if err != nil || portNum < 1 || portNum > 65535 {
		return fmt.Errorf("must use a port between 1 and 65535")
	}
	return nil
}

func validateURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("must be a valid URL")
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("must include a scheme and host")
	}
	return parsed, nil
}

func validateDatabaseURL(raw string) error {
	parsed, err := validateURL(raw)
	if err != nil {
		return err
	}
	switch strings.ToLower(parsed.Scheme) {
	case "postgres", "postgresql":
		return nil
	default:
		return fmt.Errorf("must use a postgres scheme")
	}
}

func validateS3EndpointURL(raw string) error {
	parsed, err := validateURL(raw)
	if err != nil {
		return err
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		return nil
	default:
		return fmt.Errorf("must use an http or https scheme")
	}
}

func validateS3Bucket(name string) error {
	if !s3BucketPattern.MatchString(name) {
		return fmt.Errorf("must be a lowercase S3 bucket name")
	}
	if strings.Contains(name, "..") {
		return fmt.Errorf("must not contain consecutive dots")
	}
	if net.ParseIP(name) != nil {
		return fmt.Errorf("must not be formatted as an IP address")
	}
	return nil
}

func wrapInvalid(name string, cause error) error {
	return fmt.Errorf("environment variable %q is invalid: %s", name, cause)
}
