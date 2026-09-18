---
schema_version: 1
id: phase3-rendition-encoder
title: Phase 3 Single Shot Rendition Encoder
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-rendition-encoder

allowed_paths:
  - app/backend/worker/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Reuse the Rust workspace and FFmpeg CLI to implement a single-shot Fargate encoder that produces one rendition.

**Priority:** P1. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- Do not create test code under `app/scripts/`, including standalone test files or test suites embedded in validators/runners. Preserve functional validators and execution entrypoints.
- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.


# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validator and component tests. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** `phase3-distributed-publication-state` (`phase3-20-distributed-publication-state.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.

Use a fake executor for unit tests and an explicit opt-in for real FFmpeg integration tests. Keep child execution details and full command lines out of the public API.

# Tasks

## rendition-encoder: Phase 3 Single Shot Rendition Encoder

depends_on: []

### Requirement

**Validation ownership:** Keep encoder payload, path-boundary, cancellation, and media validation tests in the Rust workspace. Use the existing contract validator for shared schemas; no Python payload-test file is required.

**Scope / Allowed Changes:** Add an encoder binary/subcommand to the same image, separate from the queue loop. Accept the internal child payload defined by Task 01: video_id, job_id, attempt, execution_id, rendition, source_key, and output_prefix. Validate the Task 01 identity/key equalities before any source download or output write. Download, encode, validate, upload segments, upload the media playlist, and finally write a success descriptor within the assigned prefix. Write the Task 01 `orchestration-child-result.schema.json` success descriptor as `result.json` after all rendition objects are uploaded. Populate only the fields defined by the shared schema, including media playlist and segment keys, positive byte sizes, MIME types, actual width, height, bandwidth, and CODECS.

Start with H.264/AAC, MPEG-TS, six-second VOD, and 360p/720p ceilings. Validate source metadata with ffprobe or equivalent and define aspect-ratio preservation, even dimensions, no upscaling, and aligned GOP/keyframe/segment boundaries. Support silent video; reject unknown, corrupt, or oversized input within bounds. Document that each rendition downloads and decodes the source independently, duplicating transfer and CPU work.

Children do not access the database or SQS. Enforce the assigned output-prefix, attempt, execution, and rendition boundaries in payload handling before any S3 write. Infrastructure/IAM tasks own the actual S3 permission restriction; do not widen this task's scope to infrastructure. Stop FFmpeg on termination/timeout. Retry a lost S3 Put response only as an SDK operation with identical bytes/key, not as unlimited re-encoding.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

- Reject unsupported rendition identifiers at the encoder payload boundary using Task 01's allowed IDs. Task 20 validates only parent master pointers and does not own this check.

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Preserve legacy single-rendition CLI tests. The new entrypoint runs without SQS polling or database credentials.
- Generate both profiles with real FFmpeg and inspect codecs, resolution, duration, segments, and MIME types with ffprobe/playlist validation.
- Distinct attempts/executions/renditions have disjoint write destinations, including delayed uploads.
- Failed work does not create a success descriptor. A child cannot publish the parent master, write COMPLETED, or acknowledge messages.
- Test bounds, traversal, malformed payloads, missing audio, invalid media, disk exhaustion, and SIGTERM.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
python app/scripts/validate_contracts.py
```

**Live acceptance:** Generate and inspect both profiles using the actual FFmpeg/ffprobe versions shipped in the image. Skips caused by missing binaries do not count as media-validation success.
