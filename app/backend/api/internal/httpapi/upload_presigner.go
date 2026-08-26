package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"time"
)

const uploadContentType = "video/mp4"

var canonicalSourceKeyPattern = regexp.MustCompile(`^videos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/jobs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/source\.mp4$`)

// PresignedUpload contains the HTTP request details returned by the presigner boundary.
type PresignedUpload struct {
	Method  string
	URL     string
	Headers http.Header
}

// UploadPresigner presigns a canonical upload request for a single video source object.
type UploadPresigner interface {
	PresignUpload(ctx context.Context, bucket, key, contentType string, expiry time.Duration) (PresignedUpload, error)
}

// S3PresignClient is the SDK boundary used by the S3 adapter.
type S3PresignClient interface {
	PresignPutObject(ctx context.Context, input S3PutObjectInput) (S3PresignResult, error)
}

// S3PutObjectInput is the minimal request payload needed to presign a PutObject call.
type S3PutObjectInput struct {
	Bucket      string
	Key         string
	ContentType string
	Expires     time.Duration
}

// S3PresignResult is the minimal presign response returned by the SDK boundary.
type S3PresignResult struct {
	URL     string
	Headers http.Header
}

// S3UploadPresigner adapts a PutObject presign client to the upload presigner boundary.
type S3UploadPresigner struct {
	client S3PresignClient
}

// NewS3UploadPresigner builds the S3 adapter around the provided client boundary.
func NewS3UploadPresigner(client S3PresignClient) *S3UploadPresigner {
	return &S3UploadPresigner{client: client}
}

// PresignUpload validates the upload contract and delegates to the SDK boundary.
func (p *S3UploadPresigner) PresignUpload(ctx context.Context, bucket, key, contentType string, expiry time.Duration) (PresignedUpload, error) {
	if p == nil {
		return PresignedUpload{}, errors.New("upload presigner is required")
	}
	if p.client == nil {
		return PresignedUpload{}, errors.New("s3 presign client is required")
	}
	if bucket == "" {
		return PresignedUpload{}, errors.New("bucket is required")
	}
	if !canonicalSourceKeyPattern.MatchString(key) {
		return PresignedUpload{}, errors.New("key must be the canonical source key")
	}
	if contentType != uploadContentType {
		return PresignedUpload{}, fmt.Errorf("content type must be %s", uploadContentType)
	}
	if expiry <= 0 {
		return PresignedUpload{}, errors.New("expiry must be greater than zero")
	}

	result, err := p.client.PresignPutObject(ctx, S3PutObjectInput{
		Bucket:      bucket,
		Key:         key,
		ContentType: contentType,
		Expires:     expiry,
	})
	if err != nil {
		return PresignedUpload{}, err
	}

	headers := cloneHeaders(result.Headers)
	if headers == nil {
		headers = make(http.Header)
	}
	headers.Set("Content-Type", contentType)

	return PresignedUpload{
		Method:  http.MethodPut,
		URL:     result.URL,
		Headers: headers,
	}, nil
}

func cloneHeaders(src http.Header) http.Header {
	if len(src) == 0 {
		return nil
	}

	dst := make(http.Header, len(src))
	for k, values := range src {
		dst[k] = append([]string(nil), values...)
	}
	return dst
}
