# Phase 1 storage conventions

This document is the shared storage contract for the Go API, AWS S3/SQS
configuration, Rust worker, and frontend. Values inside braces are placeholders;
braces are not part of an actual key.

## Identifiers

- `video_id` and `job_id` are canonical lowercase UUIDs with hyphens.
- The Go API generates both identifiers before it creates a presigned upload URL.
- Original file names are metadata only. They must never be copied into an S3 key.
- A Phase 1 video has one encoding job. Keeping both IDs in the key leaves the
  contract unambiguous when retries or replacement jobs are introduced later.

## Buckets

Logical environment variable names define the two bucket roles. Physical bucket
names are deployment-specific and must not be hard-coded by clients.

| Role | Configuration name | Contents |
| --- | --- | --- |
| Input | `VIDEO_INPUT_BUCKET` | Original browser uploads |
| Output | `VIDEO_OUTPUT_BUCKET` | HLS manifests and media segments |

The input and output roles must use different buckets in Phase 1. This prevents
worker output from matching the input `ObjectCreated` notification and creating
an encoding loop.

## Input object key

```text
videos/{video_id}/jobs/{job_id}/source.mp4
```

Example:

```text
videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4
```

Phase 1 accepts `video/mp4` only, so the stored extension is always `.mp4`.
The browser uploads with the exact `Content-Type` header returned by the API.
The presigned URL must be scoped to this exact key and to the `PUT` method.

## S3 ObjectCreated notification

The input bucket sends S3 event notifications directly to the encoding SQS
queue. Phase 1 does not define an `encoding-requested`, `encoding-progress`, or
`encoding-completed` event.

Configure the notification for:

```text
event:  s3:ObjectCreated:*
prefix: videos/
suffix: /source.mp4
```

The SQS message body is the standard S3 Event Notification JSON. The worker must:

1. Read every item in `Records`, not only the first item.
2. Accept supported `ObjectCreated:*` event names.
3. URL-decode `s3.object.key` using form-style decoding (`+` means a space).
4. Match the decoded key against the exact input key pattern above.
5. Extract `video_id` and `job_id` from the key and atomically claim the matching
   `UPLOADING` job as described below.
6. Use `s3.bucket.name` from the notification as the source bucket and verify it
   equals the configured input bucket.

`contracts/examples/s3/object-created.json` is the canonical Phase 1 fixture.
AWS test events with `Event: s3:TestEvent` are a different shape and are not an
encoding request.

## HLS output keys

The Rust worker uploads one single-quality HLS rendition under:

```text
videos/{video_id}/jobs/{job_id}/hls/
```

Required objects are:

```text
videos/{video_id}/jobs/{job_id}/hls/index.m3u8
videos/{video_id}/jobs/{job_id}/hls/segment-00000.ts
videos/{video_id}/jobs/{job_id}/hls/segment-00001.ts
videos/{video_id}/jobs/{job_id}/hls/segment-{nnnnn}.ts
```

Rules:

- `index.m3u8` is the media playlist returned by the playback API.
- MPEG-TS segment names use zero-based, five-digit numbering.
- Playlist segment references are relative names such as `segment-00000.ts`.
- Upload segments first and `index.m3u8` last. Set the job to `COMPLETED` only
  after all referenced objects have been uploaded successfully.
- Use `application/vnd.apple.mpegurl` for `.m3u8` and `video/mp2t` for `.ts`.
- Failed or incomplete attempts must never be exposed by the playback API.

## Status ownership and transitions

```text
UPLOADING -> QUEUED -> PROCESSING -> COMPLETED
                               \-> FAILED
```

| Transition | Owner | Condition |
| --- | --- | --- |
| create to `UPLOADING` | Go API | Video, job, and presigned URL are created |
| `UPLOADING` to `QUEUED` | Rust worker | A valid S3 notification is atomically claimed by one worker |
| `QUEUED` to `PROCESSING` | Rust worker | Source download and encoding work begin |
| `PROCESSING` to `COMPLETED` | Rust worker | All segments and the manifest are present in the output bucket |
| `QUEUED` or `PROCESSING` to `FAILED` | Rust worker | Phase 1 processing ends with an unrecoverable error |

### Atomic `UPLOADING` to `QUEUED` claim

SQS is at-least-once delivery, so checking the current status and updating it in
separate operations is not sufficient. After validating the bucket and key, the
worker must claim the job with one conditional update:

```sql
UPDATE jobs
SET status = 'QUEUED',
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
  AND video_id = $2
  AND status = 'UPLOADING';
```

`$1` is the `job_id` and `$2` is the `video_id` extracted from the decoded S3
object key. Exactly the worker whose update affects one row may continue. An
update count of zero means another delivery already claimed the job, the job is
terminal, or the IDs do not match; that message must be ignored without running
FFmpeg or overwriting output.

The worker changes `QUEUED` to `PROCESSING` immediately before source download
and FFmpeg execution. Lease recovery, visibility-timeout heartbeat, retry policy,
and DLQ handling remain Phase 2 concerns. Consequently, Phase 1 accepts that a
worker crash after the atomic claim can leave a job in `QUEUED` or `PROCESSING`.

## Phase 1 HLS delivery and playback URL

For a completed job, the API resolves the manifest object:

```text
s3://{VIDEO_OUTPUT_BUCKET}/videos/{video_id}/jobs/{job_id}/hls/index.m3u8
```

and returns the virtual-hosted S3 HTTPS URL as `manifestUrl`. The browser then
loads `index.m3u8` and its relative `.ts` segment references directly from the
output bucket. A presigned URL for the manifest alone is not sufficient because
it does not authorize the segment requests.

The Phase 1 output bucket must therefore allow unauthenticated `s3:GetObject`
only for published HLS objects under this resource pattern:

```text
arn:aws:s3:::{VIDEO_OUTPUT_BUCKET}/videos/*/jobs/*/hls/*
```

Do not grant `s3:ListBucket`, write access, or any public access to the input
bucket. The output bucket must return the content types defined above so both the
playlist and segments are usable by an HLS player.

Configure S3 CORS with each actual frontend origin (do not use `*` in deployed
environments). A local Phase 1 example is:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

CloudFront, Origin Access Control (OAC), and a private output bucket are Phase 2
concerns. Introducing them later must not change the S3 key layout or the
playback API response shape.
