package httpapi

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/testutil"
)

func TestAPICompatibilityAcrossMigrations(t *testing.T) {
	migrations := testutil.Migrations(t)
	for seedVersion := 1; seedVersion <= len(migrations); seedVersion++ {
		name := "new_job_on_latest_schema"
		if seedVersion < len(migrations) {
			name = fmt.Sprintf("upgrade_from_%s", migrations[seedVersion-1].Version)
		}
		t.Run(name, func(t *testing.T) {
			db := testutil.OpenPostgres(t)
			testutil.ApplyMigrations(t, db, migrations[:seedVersion])
			repo := persistence.NewPostgresRepository(db)
			signer := &fakeUploadPresigner{result: PresignedUpload{
				Method: http.MethodPut, URL: "https://example.test/upload", Headers: http.Header{"Content-Type": {"video/mp4"}},
			}}
			handler := NewRouterWithServices(testCreationService(repo, signer), NewVideoStatusService(repo),
				NewVideoPlaybackService(repo, testOutputBucket, testOutputEndpoint))
			request := func(method, path, body string, status int) []byte {
				t.Helper()
				rr := httptest.NewRecorder()
				handler.ServeHTTP(rr, httptest.NewRequest(method, path, strings.NewReader(body)))
				if rr.Code != status {
					t.Fatalf("%s %s: status=%d body=%s", method, path, rr.Code, rr.Body.String())
				}
				return rr.Body.Bytes()
			}
			created := request(http.MethodPost, "/api/v1/videos", `{"fileName":"sample.mp4","contentType":"video/mp4","sizeBytes":104857600}`, http.StatusCreated)
			assertJSONKeysMatch(t, created, readContractExample(t, "create-video-response.json"), "")
			var creation createVideoResponse
			if err := json.Unmarshal(created, &creation); err != nil {
				t.Fatal(err)
			}
			wantKey := "videos/" + string(testVideoID) + "/jobs/" + string(testJobID) + "/source.mp4"
			if creation.VideoID != testVideoID || creation.Job.JobID != testJobID || creation.Job.Status != persistence.JobStatusUploading ||
				creation.Upload.Object.Key != wantKey || creation.Upload.Method != "PUT" || creation.Upload.URL != signer.result.URL {
				t.Fatalf("unexpected creation response: %#v", creation)
			}
			testutil.ApplyMigrations(t, db, migrations[seedVersion:])
			var attempt int
			var owner sql.NullString
			var expires sql.NullTime
			if err := db.QueryRow("SELECT attempt, worker_id, lease_expires_at FROM jobs WHERE id = $1", testJobID).
				Scan(&attempt, &owner, &expires); err != nil {
				t.Fatal(err)
			}
			if attempt != 0 || owner.Valid || expires.Valid {
				t.Fatalf("unsafe lease defaults: %d, %v, %v", attempt, owner, expires)
			}

			path := "/api/v1/videos/" + string(testVideoID)
			for _, status := range persistence.AllJobStatuses {
				t.Run(string(status), func(t *testing.T) {
					// Seed worker-owned state through SQL; HTTP still uses the production repository.
					_, err := db.Exec(`UPDATE jobs SET status = $1,
						worker_id = CASE WHEN $1 = 'PROCESSING' THEN 'internal-worker' ELSE NULL END,
						lease_expires_at = CASE WHEN $1 = 'PROCESSING' THEN NOW() + interval '5 minutes' ELSE NULL END,
						attempt = 2,
						failure_code = CASE WHEN $1 = 'FAILED' THEN 'ENCODING_FAILED' ELSE NULL END,
						failure_message = CASE WHEN $1 = 'FAILED' THEN 'Encoding failed.' ELSE NULL END
						WHERE id = $2`, status, testJobID)
					if err != nil {
						t.Fatal(err)
					}
					body := request(http.MethodGet, path, "", http.StatusOK)
					assertJSONKeysMatch(t, body, readContractExample(t, "get-video-response.json"), "")
					var got videoStatusResponse
					if err := json.Unmarshal(body, &got); err != nil {
						t.Fatal(err)
					}
					if got.VideoID != testVideoID || got.Job.JobID != testJobID || got.Job.Status != status ||
						got.FileName != "sample.mp4" || got.SizeBytes != 104857600 || got.ContentType != "video/mp4" {
						t.Fatalf("unexpected status response: %#v", got)
					}
					if status == persistence.JobStatusFailed {
						if got.Job.Failure == nil || got.Job.Failure.Code != "ENCODING_FAILED" || got.Job.Failure.Message != "Encoding failed." {
							t.Fatalf("unexpected failure: %#v", got.Job.Failure)
						}
					} else if got.Job.Failure != nil {
						t.Fatalf("unexpected public failure: %#v", got.Job.Failure)
					}
					if status == persistence.JobStatusCompleted {
						playback := request(http.MethodGet, path+"/playback", "", http.StatusOK)
						assertJSONKeysMatch(t, playback, readContractExample(t, "get-playback-response.json"), "")
						var got playbackResponse
						if err := json.Unmarshal(playback, &got); err != nil {
							t.Fatal(err)
						}
						if got.VideoID != testVideoID || got.JobID != testJobID || got.Protocol != "HLS" || got.ContentType != playbackContentType ||
							got.ManifestURL != testOutputEndpoint+"/videos/"+string(testVideoID)+"/jobs/"+string(testJobID)+"/hls/index.m3u8" {
							t.Fatalf("unexpected playback: %#v", got)
						}
					} else {
						body := request(http.MethodGet, path+"/playback", "", http.StatusConflict)
						var got map[string]string
						if err := json.Unmarshal(body, &got); err != nil {
							t.Fatal(err)
						}
						if got["code"] != "VIDEO_NOT_READY" {
							t.Fatalf("unexpected playback error: %s", body)
						}
					}
				})
			}
		})
	}
}
