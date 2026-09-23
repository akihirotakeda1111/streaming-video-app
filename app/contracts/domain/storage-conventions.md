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

## Phase 3 HLS delivery and playback URL

Phase 2 provides the completed reliability baseline. Phase 3 introduces
CloudFront, Origin Access Control (OAC), and private output delivery. The
Phase 1/2 public-S3 configuration is a migration source, not the target policy.

For a completed job, the API appends the published relative manifest key to
the operator-supplied HTTPS PLAYBACK_BASE_URL, without inserting the bucket name.
A NULL pointer on a legacy completed job resolves to
videos/{video_id}/jobs/{job_id}/hls/index.m3u8. Distributed completed jobs require
their attempt-scoped master pointer. S3 SDK endpoints are separate configuration.

The output bucket MUST reject anonymous S3 GET/HEAD. Enable all S3 Block Public
Access settings and remove public-read policies/ACLs in the final configuration.
OAC signs requests to the S3 REST origin. Grant the CloudFront service principal
s3:GetObject only for HLS media, restricted to the designated distribution ARN.
Do not grant viewers S3 listing or writes, or public access to the input bucket.
Internal result.json objects MUST NOT be readable through CloudFront; exclude
them from OAC access as specified in scalability-conventions.md. Parent and child
access to these objects uses separate authenticated IAM permissions.

Viewers use public HTTPS at CloudFront for playlists and their relative media
references. Preserve the HLS MIME types above. Viewer authentication and signed
cookies are out of scope; the API's 409 not-ready gate is not authorization for
guessed CloudFront paths. CORS is not authentication.

Configure CloudFront CORS for actual frontend origins, including cached
responses for manifests and segments. Allow GET/HEAD and OPTIONS as needed;
do not use a wildcard deployed origin. S3 CORS remains necessary for direct
browser uploads to the input bucket and any explicitly supported direct SDK
inspection; it does not provide viewer access to the private output bucket.

Prepare CloudFront/OAC, switch the API delivery origin, verify manifest/segment
playback, then revoke anonymous S3 reads and enforce Block Public Access.
Enable distributed processing after this cutover. Rollback retains private S3
and a pointer-aware, CloudFront-capable API so distributed completed jobs remain
playable. Existing source and completed-output keys are never moved or renamed.
See scalability-conventions.md for attempt keys, result storage, and rollout.
