---
contract_version: 1
contract_id: phase3-scalability
status_schema: job-status.schema.json
storage_contract: storage-conventions.md
reliability_contract: reliability-conventions.md
parent_input_schema: orchestration-parent-input.schema.json
child_input_schema: orchestration-child-input.schema.json
child_result_schema: orchestration-child-result.schema.json
parent_input_fixture: ../examples/internal/parent-input.json
child_input_fixture: ../examples/internal/child-input.json
child_result_fixture: ../examples/internal/child-result.json
modes:
  default: cli
  supported: [cli, distributed]
  immutable_after_first_acquisition: true
results:
  transport: s3
  bucket: VIDEO_OUTPUT_BUCKET
  filename: result.json
  content_type: application/json
  ecs_integration: ecs:runTask.sync
  cloudfront_readable: false
delivery:
  playback_base_url: PLAYBACK_BASE_URL
  scheme: https
  bucket_private: true
  origin_access_control: true
  path_has_bucket_name: false
---

# Phase 3 scalability and delivery conventions

This document owns only the distributed-processing, delivery, and cloud-scaling
delta. The five public statuses, SQS acknowledgement rules, leases, heartbeats,
retry/DLQ behavior, and immutable `COMPLETED` semantics remain defined by
`job-status.schema.json`, `storage-conventions.md`, and
`reliability-conventions.md`.

## Modes and ownership

`mode` is an internal database field with exactly `cli` or `distributed` as its
values. The default is `cli`; deployments explicitly enable `distributed`.
The mode is persisted when the job is first acquired for processing and never
changes on retry or reacquisition. It is not present in OpenAPI responses.

The existing Rust worker remains an ECS/Fargate service consuming Standard SQS
messages. In `cli` mode it performs the existing single-rendition path. In
`distributed` mode it is the coordinator: it starts and monitors one Standard
Step Functions execution, validates the child results, publishes the parent
master last, commits the manifest pointer and `COMPLETED` under the current
owner/attempt predicates, and only then acknowledges SQS.

The execution uses an Inline Map with `MaxConcurrency: 2`. Each map item starts
one single-shot Fargate encoder for exactly one rendition. A child owns source
download, one FFmpeg CLI invocation, and upload to its assigned prefix. A child
receives no SQS receipt handle, database credential, or completion authority.
Child success and Step Functions `SUCCEEDED` are not job completion.
Each item uses `ecs:runTask.sync` to wait for container termination. Results
are stored in S3, not returned through stdout or a task-token callback.

The fixed rendition IDs are `360p` (ceiling 640x360) and `720p` (ceiling
1280x720). Encoders never upscale; a source smaller than a ceiling may produce
only the applicable rendition. Parallel two-rendition validation requires a
source of at least 720p. Each rendition retains six-second VOD segments,
`application/vnd.apple.mpegurl` for playlists, `video/mp2t` for segments, and
relative segment references.

The parent deadline is measured from SQS receipt and is strictly inside the
original visibility lifetime. Heartbeats do not make the deadline indefinite.
StartExecution uses a deterministic `job_id`/`attempt` execution name and the
same immutable input on retry. A lost response is resolved by looking up that
name. Execution cancellation is best effort and is never the only ownership
fence. Child task retries are initially zero; child failure returns to the
existing parent retry policy.
Only successful SQS-driven lease acquisition/reacquisition increments attempt;
starting or describing an execution, SDK retries, and child work never do so.

## Keys and publication

Legacy completed jobs retain their source key and:

```text
videos/{video_id}/jobs/{job_id}/hls/index.m3u8
videos/{video_id}/jobs/{job_id}/hls/segment-{nnnnn}.ts
```

Only distributed jobs add these attempt-isolated objects:

```text
videos/{video_id}/jobs/{job_id}/hls/attempts/{attempt}/{execution_id}/{rendition}/index.m3u8
videos/{video_id}/jobs/{job_id}/hls/attempts/{attempt}/{execution_id}/{rendition}/segment-{nnnnn}.ts
videos/{video_id}/jobs/{job_id}/hls/attempts/{attempt}/{execution_id}/{rendition}/result.json
videos/{video_id}/jobs/{job_id}/hls/attempts/{attempt}/{execution_id}/index.m3u8
```

The child writes rendition objects: segments first, media playlist next, and
`result.json` last with `application/json`; only then does it exit successfully.
The parent validates all referenced child objects, publishes its master last,
and then atomically persists `published_manifest_key` and `COMPLETED`
with matching owner and attempt predicates. `published_manifest_key` is
nullable and internal: NULL on a legacy completed job resolves to the original
`hls/index.m3u8`; a distributed completed job must have the attempt master key.
Late child uploads cannot overwrite another attempt. Existing objects are never
moved or renamed.

### Input identity and S3 result contract

JSON Schema checks field shapes. Producers and consumers MUST additionally
validate the following equalities before source download, output writes, or
publication; schema validation alone is insufficient:

```text
execution_id = job-{job_id}-a{attempt}
source_key = videos/{video_id}/jobs/{job_id}/source.mp4
parent.output_prefix = videos/{video_id}/jobs/{job_id}/hls/attempts/{attempt}/{execution_id}
child.output_prefix = parent.output_prefix/{rendition}
result_key = child.output_prefix/result.json
```

Parent, child, and result must have identical video_id, job_id, attempt,
execution_id, and source_key; the result output_prefix and rendition must match
the assigned child. The child rendition must belong to the parent's renditions.
Reject mismatches rather than normalizing paths or accepting another job/attempt.
The result key is derived, never accepted from an untrusted result or task output.

`orchestration-child-result.schema.json` defines a successful rendition result.
The child records its media playlist and every segment with the full S3 key,
positive byte size, and MIME type, plus actual width, height, peak bandwidth in
bits/second, and the HLS CODECS string. Segments are listed in playlist order,
numbered from zero with five digits. The media playlist key must be
`child.output_prefix/index.m3u8`; segment keys must be
`child.output_prefix/segment-{nnnnn}.ts`. No failed-result payload is published.

After Step Functions succeeds, the parent uses authenticated S3 reads to fetch
exactly one result for every requested rendition from VIDEO_OUTPUT_BUCKET.
It validates the result schema and identity, then verifies existence, positive
size, MIME type, and playlist contents against all descriptors. Playlist segment
references must be the matching relative filenames in the same order, with no
absolute URLs, traversal, or references outside the assigned prefix. Reject
missing/extra segments or renditions. Validate actual media dimensions, codecs,
and bandwidth before using them in the master; dimensions must respect the
rendition ceiling and must not exceed the source. JSON claims are not proof of
valid media. Parent publication remains segments, media playlists, result JSONs,
parent master, and conditional database completion, in that order.

A missing, malformed, mismatched, or unreadable result prevents publication and
uses the existing retry/lease policy without acknowledgement. A result left by
a task that subsequently fails does not override execution failure. Lost S3 PUT
responses may be retried only with identical bytes and keys within the deadline.
Residual results belong to their original attempt and cannot complete a new one.
Retention/cleanup must preserve objects referenced by completed jobs; this
contract does not authorize deleting those objects.

## Delivery contract

`PLAYBACK_BASE_URL` is an operator-supplied HTTPS delivery origin, separate
from S3 SDK endpoints. `manifestUrl` is formed by appending the published
relative key to that origin; the bucket name is never inserted into a
CloudFront path. Phase 2 provides the completed reliability baseline. Phase 3
introduces CloudFront/OAC and private output delivery without changing the API
response shape; these delivery components are not prerequisites already
implemented by Phase 2.
Viewer delivery is public HTTPS at the distribution edge. Viewer
authentication and signed cookies are out of scope. The API's 409 not-ready
gate is not authorization for guessed CloudFront URLs.
Internal `result.json` objects are never viewer content. OAC read permissions
must exclude them, including an explicit deny of `s3:GetObject` to the CloudFront
service principal for `videos/*/jobs/*/hls/attempts/*/*/*/result.json` if a broader
HLS allow is present. Parent/child IAM permissions separately allow only required
result reads/writes. Do not put result JSON into public API responses or playlists.

## Capacity, runtime, and rollout

Each ECS service task receives one message at a time. Initial learning limits
are min=1 and max=4 coordinator tasks; scale-to-zero is deferred. Set the
backlog-per-task target from measured CLI processing time and acceptable queue
delay. Four distributed parents with two children each imply at most eight
active encoders. Residual tasks from failed executions are tracked separately,
and overlap is bounded so failed executions cannot create unbounded children.

The cloud topology is a dedicated VPC, a small private Single-AZ PostgreSQL
RDS instance, the existing API on Fargate behind an HTTPS ALB, and the worker
service. The local Compose database and NoTls adapter require verified TLS
before cloud deployment. ACM certificates, frontend origin, image digests,
and other environment values are operator-supplied.

Migration is additive: deploy `published_manifest_key` nullable and a
pointer-aware API, drain old workers, and prepare CloudFront/OAC against the
existing bucket. Switch the API to PLAYBACK_BASE_URL, verify manifest and segment
delivery, then remove anonymous S3 read policies and enforce all S3 Block Public
Access settings. Enable `distributed` only after private delivery is verified.
The existing public configuration is a transitional state, not the target policy.
Rollback disables distributed mode for newly acquired jobs and drains existing
coordinators without changing persisted job modes. Retain private S3, additive
columns, and an API that resolves published pointers and CloudFront URLs;
legacy completed jobs with NULL pointers still resolve to the original key.
Do not roll back to a legacy-only API or workers that cannot honor persisted
distributed jobs; retain compatible coordinators until those jobs are drained.

| Situation | Parent action | SQS action |
| --- | --- | --- |
| Child failure or parent deadline | Stop publication; use existing retry/lease policy | Do not acknowledge |
| Missing, invalid, or mismatched S3 result/objects | Stop publication; use existing retry/lease policy | Do not acknowledge |
| Lost StartExecution response | Describe deterministic execution name with identical input | Keep ownership and message unacknowledged until resolved |
| Lost lease/heartbeat | Stop children and all publication where possible | Do not release, complete, or acknowledge |
| All children valid and parent master published | Commit pointer and `COMPLETED` under owner/attempt predicates | Acknowledge only after durable commit |
| Delete failure after commit | Preserve immutable completion | Retry acknowledgement on redelivery |
