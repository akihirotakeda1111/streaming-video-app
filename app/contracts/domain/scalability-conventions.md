---
contract_version: 1
contract_id: phase3-scalability
status_schema: job-status.schema.json
storage_contract: storage-conventions.md
reliability_contract: reliability-conventions.md
parent_input_schema: orchestration-parent-input.schema.json
child_input_schema: orchestration-child-input.schema.json
parent_input_fixture: ../examples/internal/parent-input.json
child_input_fixture: ../examples/internal/child-input.json
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
videos/{video_id}/jobs/{job_id}/hls/attempts/{attempt}/{execution_id}/index.m3u8
```

The child writes rendition objects, segments first and its media playlist last.
The parent validates all referenced child objects, publishes its master last,
and then atomically persists `published_manifest_key` and `COMPLETED`
with matching owner and attempt predicates. `published_manifest_key` is
nullable and internal: NULL on a legacy completed job resolves to the original
`hls/index.m3u8`; a distributed completed job must have the attempt master key.
Late child uploads cannot overwrite another attempt. Existing objects are never
moved or renamed.

## Delivery contract

`PLAYBACK_BASE_URL` is an operator-supplied HTTPS delivery origin, separate
from S3 SDK endpoints. `manifestUrl` is formed by appending the published
relative key to that origin; the bucket name is never inserted into a
CloudFront path. Phase 2 owns the CloudFront/OAC private-bucket baseline; Phase
3 defines the cutover and uses it without changing the API response shape.
Viewer delivery is public HTTPS at the distribution edge. Viewer
authentication and signed cookies are out of scope. The API's 409 not-ready
gate is not authorization for guessed CloudFront URLs.

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

Migration is additive: deploy `published_manifest_key` nullable, drain old
workers, cut CloudFront/OAC over while retaining private S3, then enable
`distributed` for selected deployments. Rollback disables the new mode, drains
coordinators, and retains the private bucket and additive column; legacy
workers continue resolving NULL to the original key.

| Situation | Parent action | SQS action |
| --- | --- | --- |
| Child failure or parent deadline | Stop publication; use existing retry/lease policy | Do not acknowledge |
| Lost StartExecution response | Describe deterministic execution name with identical input | Keep ownership and message unacknowledged until resolved |
| Lost lease/heartbeat | Stop children and all publication where possible | Do not release, complete, or acknowledge |
| All children valid and parent master published | Commit pointer and `COMPLETED` under owner/attempt predicates | Acknowledge only after durable commit |
| Delete failure after commit | Preserve immutable completion | Retry acknowledgement on redelivery |
