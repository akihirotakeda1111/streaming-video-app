package httpapi

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

func TestVideoCreationServiceCreateVideoPersistsCanonicalKey(t *testing.T) {
	repo := &fakeVideoCreationRepo{}
	idCalls := 0
	svc := &VideoCreationService{
		repo:         repo,
		uploadBucket: "input-bucket",
		uploadTTL:    30 * time.Minute,
		now: func() time.Time {
			return time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
		},
		newCanonicalID: func() (persistence.CanonicalUUID, error) {
			idCalls++
			switch idCalls {
			case 1:
				return persistence.CanonicalUUID("11111111-1111-1111-1111-111111111111"), nil
			default:
				return persistence.CanonicalUUID("22222222-2222-2222-2222-222222222222"), nil
			}
		},
	}

	got, err := svc.CreateVideo(context.Background(), CreateVideoRequest{
		FileName:    "client-name.mp4",
		ContentType: "video/mp4",
		SizeBytes:   12345,
	})
	if err != nil {
		t.Fatalf("CreateVideo() error = %v", err)
	}

	if len(repo.inputs) != 1 {
		t.Fatalf("repo input count = %d, want 1", len(repo.inputs))
	}
	input := repo.inputs[0]
	if input.VideoID != persistence.CanonicalUUID("11111111-1111-1111-1111-111111111111") {
		t.Fatalf("VideoID = %q, want canonical UUID", input.VideoID)
	}
	if input.JobID != persistence.CanonicalUUID("22222222-2222-2222-2222-222222222222") {
		t.Fatalf("JobID = %q, want canonical UUID", input.JobID)
	}
	wantKey := "videos/11111111-1111-1111-1111-111111111111/jobs/22222222-2222-2222-2222-222222222222/source.mp4"
	if input.Upload.Key != wantKey {
		t.Fatalf("Upload.Key = %q, want %q", input.Upload.Key, wantKey)
	}
	if input.Upload.Key == "client-name.mp4" || input.Upload.Key == "uploads/client-name.mp4" {
		t.Fatalf("Upload.Key unexpectedly contains the client file name: %q", input.Upload.Key)
	}
	if input.Upload.Bucket != "input-bucket" {
		t.Fatalf("Upload.Bucket = %q, want %q", input.Upload.Bucket, "input-bucket")
	}
	wantExpiresAt := time.Date(2026, time.August, 26, 12, 30, 0, 0, time.UTC)
	if !input.Upload.ExpiresAt.Equal(wantExpiresAt) {
		t.Fatalf("Upload.ExpiresAt = %v, want %v", input.Upload.ExpiresAt, wantExpiresAt)
	}
	if got.FileName != "client-name.mp4" || got.ContentType != "video/mp4" || got.SizeBytes != 12345 {
		t.Fatalf("returned video metadata = %#v", got)
	}
	if got.Job.Status != persistence.JobStatusUploading {
		t.Fatalf("Job.Status = %q, want %q", got.Job.Status, persistence.JobStatusUploading)
	}
}

func TestVideoCreationServiceRejectsInvalidMetadata(t *testing.T) {
	tests := []struct {
		name string
		req  CreateVideoRequest
	}{
		{
			name: "content_type",
			req: CreateVideoRequest{
				FileName:    "sample.mp4",
				ContentType: "video/mpeg",
				SizeBytes:   1,
			},
		},
		{
			name: "size_zero",
			req: CreateVideoRequest{
				FileName:    "sample.mp4",
				ContentType: "video/mp4",
				SizeBytes:   0,
			},
		},
		{
			name: "size_negative",
			req: CreateVideoRequest{
				FileName:    "sample.mp4",
				ContentType: "video/mp4",
				SizeBytes:   -1,
			},
		},
		{
			name: "size_too_large",
			req: CreateVideoRequest{
				FileName:    "sample.mp4",
				ContentType: "video/mp4",
				SizeBytes:   maxSizeBytes + 1,
			},
		},
		{
			name: "file_name_empty",
			req: CreateVideoRequest{
				FileName:    "",
				ContentType: "video/mp4",
				SizeBytes:   1,
			},
		},
		{
			name: "file_name_too_long",
			req: CreateVideoRequest{
				FileName:    strings.Repeat("a", maxFileNameLength+1),
				ContentType: "video/mp4",
				SizeBytes:   1,
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repo := &fakeVideoCreationRepo{}
			svc := &VideoCreationService{
				repo:         repo,
				uploadBucket: "input-bucket",
				uploadTTL:    time.Minute,
				now:          time.Now,
				newCanonicalID: func() (persistence.CanonicalUUID, error) {
					return persistence.CanonicalUUID("11111111-1111-1111-1111-111111111111"), nil
				},
			}

			_, err := svc.CreateVideo(context.Background(), tc.req)
			if err == nil {
				t.Fatal("CreateVideo() error = nil, want validation failure")
			}

			var vErr *ValidationError
			if !errors.As(err, &vErr) {
				t.Fatalf("CreateVideo() error = %v, want ValidationError", err)
			}
			if len(repo.inputs) != 0 {
				t.Fatal("CreateVideo() persisted invalid input")
			}
		})
	}
}

func TestVideoCreationServiceAcceptsContractBounds(t *testing.T) {
	tests := []struct {
		name string
		req  CreateVideoRequest
	}{
		{
			name: "size_max",
			req: CreateVideoRequest{
				FileName:    "sample.mp4",
				ContentType: "video/mp4",
				SizeBytes:   maxSizeBytes,
			},
		},
		{
			name: "file_name_max",
			req: CreateVideoRequest{
				FileName:    strings.Repeat("a", maxFileNameLength),
				ContentType: "video/mp4",
				SizeBytes:   1,
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repo := &fakeVideoCreationRepo{}
			svc := &VideoCreationService{
				repo:         repo,
				uploadBucket: "input-bucket",
				uploadTTL:    time.Minute,
				now:          time.Now,
				newCanonicalID: func() (persistence.CanonicalUUID, error) {
					return persistence.CanonicalUUID("11111111-1111-1111-1111-111111111111"), nil
				},
			}

			if _, err := svc.CreateVideo(context.Background(), tc.req); err != nil {
				t.Fatalf("CreateVideo() error = %v, want nil", err)
			}
			if len(repo.inputs) != 1 {
				t.Fatalf("repo input count = %d, want 1", len(repo.inputs))
			}
		})
	}
}

func TestVideoCreationServicePropagatesRepositoryFailure(t *testing.T) {
	repoErr := errors.New("insert failed")
	repo := &fakeVideoCreationRepo{
		err: repoErr,
	}
	svc := &VideoCreationService{
		repo:         repo,
		uploadBucket: "input-bucket",
		uploadTTL:    time.Minute,
		now: func() time.Time {
			return time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
		},
		newCanonicalID: func() (persistence.CanonicalUUID, error) {
			return persistence.CanonicalUUID("11111111-1111-1111-1111-111111111111"), nil
		},
	}

	_, err := svc.CreateVideo(context.Background(), CreateVideoRequest{
		FileName:    "sample.mp4",
		ContentType: "video/mp4",
		SizeBytes:   1,
	})
	if !errors.Is(err, repoErr) {
		t.Fatalf("CreateVideo() error = %v, want %v", err, repoErr)
	}
	if len(repo.inputs) != 1 {
		t.Fatalf("repo input count = %d, want 1", len(repo.inputs))
	}
}

type fakeVideoCreationRepo struct {
	inputs []persistence.CreateVideoInput
	err    error
}

func (r *fakeVideoCreationRepo) CreateVideo(_ context.Context, input persistence.CreateVideoInput) (persistence.Video, error) {
	r.inputs = append(r.inputs, input)
	if r.err != nil {
		return persistence.Video{}, r.err
	}

	return persistence.Video{
		VideoID:     input.VideoID,
		FileName:    input.FileName,
		ContentType: input.ContentType,
		SizeBytes:   input.SizeBytes,
		Upload:      input.Upload,
		Job: persistence.EncodingJob{
			JobID:   input.JobID,
			VideoID: input.VideoID,
			Status:  persistence.JobStatusUploading,
		},
	}, nil
}

func (r *fakeVideoCreationRepo) GetVideoByID(context.Context, persistence.CanonicalUUID) (persistence.Video, error) {
	panic("unexpected GetVideoByID call")
}
