package httpapi

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

const testInputBucket = "input-bucket"

func TestS3UploadPresignerPresignUploadForwardsCanonicalPutObject(t *testing.T) {
	client := &fakeS3PresignClient{headers: sdkSignedPutHeaders()}
	presigner := NewS3UploadPresigner(client, testInputBucket)

	got, err := presigner.PresignUpload(
		context.Background(),
		testInputBucket,
		testCanonicalSourceKey,
		uploadContentType,
		15*time.Minute,
	)
	if err != nil {
		t.Fatalf("PresignUpload() error = %v", err)
	}

	if client.calls != 1 {
		t.Fatalf("client calls = %d, want 1", client.calls)
	}

	if client.input.Bucket != "input-bucket" {
		t.Fatalf("Bucket = %q, want %q", client.input.Bucket, "input-bucket")
	}
	if client.input.Key != testCanonicalSourceKey {
		t.Fatalf("Key = %q, want canonical source key", client.input.Key)
	}
	if client.input.ContentType != uploadContentType {
		t.Fatalf("ContentType = %q, want %q", client.input.ContentType, uploadContentType)
	}
	if client.input.Expires != 15*time.Minute {
		t.Fatalf("Expires = %v, want %v", client.input.Expires, 15*time.Minute)
	}

	if got.Method != http.MethodPut {
		t.Fatalf("Method = %q, want %q", got.Method, http.MethodPut)
	}
	if got.URL != "https://example.invalid/presigned" {
		t.Fatalf("URL = %q, want %q", got.URL, "https://example.invalid/presigned")
	}
	assertPreservedSignedHeaders(t, got.Headers, client.headers)
	if got.Headers.Get("Content-Type") != uploadContentType {
		t.Fatalf("Content-Type header = %q, want %q", got.Headers.Get("Content-Type"), uploadContentType)
	}
}

func TestS3UploadPresignerPreservesSDKSignedHeaders(t *testing.T) {
	signed := sdkSignedPutHeaders()
	client := &fakeS3PresignClient{headers: signed}
	presigner := NewS3UploadPresigner(client, testInputBucket)

	got, err := presigner.PresignUpload(context.Background(), testInputBucket, testCanonicalSourceKey, uploadContentType, time.Minute)
	if err != nil {
		t.Fatalf("PresignUpload() error = %v", err)
	}

	assertPreservedSignedHeaders(t, got.Headers, signed)
	got.Headers.Values("X-Amz-Checksum-Crc32")[0] = "mutated"
	if signed.Get("X-Amz-Checksum-Crc32") != "i9aeUg==" {
		t.Fatal("returned headers aliased the SDK signed header values")
	}
}

func TestS3UploadPresignerAddsContentTypeWhenSDKOmitsHeaders(t *testing.T) {
	client := &fakeS3PresignClient{headers: http.Header{}}
	presigner := NewS3UploadPresigner(client, testInputBucket)

	got, err := presigner.PresignUpload(context.Background(), testInputBucket, testCanonicalSourceKey, uploadContentType, time.Minute)
	if err != nil {
		t.Fatalf("PresignUpload() error = %v", err)
	}
	if got.Headers.Get("Content-Type") != uploadContentType {
		t.Fatalf("Content-Type header = %q, want %q", got.Headers.Get("Content-Type"), uploadContentType)
	}
}

func TestS3UploadPresignerRejectsInvalidInputsBeforeClientCall(t *testing.T) {
	tests := []struct {
		name        string
		bucket      string
		key         string
		contentType string
		expiry      time.Duration
	}{
		{
			name:        "empty_bucket",
			bucket:      "",
			key:         testCanonicalSourceKey,
			contentType: uploadContentType,
			expiry:      time.Minute,
		},
		{
			name:        "noncanonical_key",
			bucket:      testInputBucket,
			key:         "videos/11111111-1111-1111-1111-111111111111/jobs/22222222-2222-2222-2222-222222222222/upload.mp4",
			contentType: uploadContentType,
			expiry:      time.Minute,
		},
		{
			name:        "uppercase_uuid",
			bucket:      testInputBucket,
			key:         "videos/11111111-1111-1111-1111-111111111111/jobs/22222222-2222-2222-2222-22222222222A/source.mp4",
			contentType: uploadContentType,
			expiry:      time.Minute,
		},
		{
			name:        "wrong_content_type",
			bucket:      testInputBucket,
			key:         testCanonicalSourceKey,
			contentType: "video/mpeg",
			expiry:      time.Minute,
		},
		{
			name:        "nonpositive_expiry",
			bucket:      testInputBucket,
			key:         testCanonicalSourceKey,
			contentType: uploadContentType,
			expiry:      0,
		},
		{
			name:        "wrong_bucket",
			bucket:      "other-bucket",
			key:         testCanonicalSourceKey,
			contentType: uploadContentType,
			expiry:      time.Minute,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := &fakeS3PresignClient{}
			presigner := NewS3UploadPresigner(client, testInputBucket)

			_, err := presigner.PresignUpload(context.Background(), tc.bucket, tc.key, tc.contentType, tc.expiry)
			if err == nil {
				t.Fatal("PresignUpload() error = nil, want failure")
			}
			if client.calls != 0 {
				t.Fatalf("client calls = %d, want 0", client.calls)
			}
		})
	}
}

func TestS3UploadPresignerPropagatesClientError(t *testing.T) {
	clientErr := errors.New("presign failed")
	client := &fakeS3PresignClient{err: clientErr}
	presigner := NewS3UploadPresigner(client, testInputBucket)

	_, err := presigner.PresignUpload(
		context.Background(),
		testInputBucket,
		testCanonicalSourceKey,
		uploadContentType,
		time.Minute,
	)
	if !errors.Is(err, clientErr) {
		t.Fatalf("PresignUpload() error = %v, want %v", err, clientErr)
	}
	if client.calls != 1 {
		t.Fatalf("client calls = %d, want 1", client.calls)
	}
}

const testCanonicalSourceKey = "videos/11111111-1111-1111-1111-111111111111/jobs/22222222-2222-2222-2222-222222222222/source.mp4"

func sdkSignedPutHeaders() http.Header {
	return http.Header{
		"Content-Type":                 []string{uploadContentType},
		"X-Amz-Checksum-Crc32":         []string{"i9aeUg=="},
		"X-Amz-Sdk-Checksum-Algorithm": []string{"CRC32"},
		"X-Amz-Test":                   []string{"1"},
	}
}

func assertPreservedSignedHeaders(t *testing.T, got, signed http.Header) {
	t.Helper()
	if signed.Get("X-Amz-Test") == "" {
		t.Fatal("signed fixture is missing X-Amz-Test")
	}
	for name, values := range signed {
		gotValues := got.Values(name)
		if len(gotValues) != len(values) {
			t.Fatalf("header %q = %v, want SDK signed values %v", name, gotValues, values)
		}
		for i, value := range values {
			if gotValues[i] != value {
				t.Fatalf("header %q = %v, want SDK signed values %v", name, gotValues, values)
			}
		}
	}
}

type fakeS3PresignClient struct {
	calls   int
	input   S3PutObjectInput
	headers http.Header
	err     error
}

func (c *fakeS3PresignClient) PresignPutObject(_ context.Context, input S3PutObjectInput) (S3PresignResult, error) {
	c.calls++
	c.input = input
	if c.err != nil {
		return S3PresignResult{}, c.err
	}
	headers := c.headers
	if headers == nil {
		headers = sdkSignedPutHeaders()
	}

	return S3PresignResult{
		URL:     "https://example.invalid/presigned",
		Headers: headers,
	}, nil
}
