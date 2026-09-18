---
schema_version: 1
id: phase3-distributed-publication-state
title: Phase 3 Distributed Attempt and Publication State
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-distributed-publication-state

allowed_paths:
  - app/backend/api/internal/persistence/**
  - app/backend/api/internal/httpapi/playback.go
  - app/backend/api/internal/httpapi/playback_test.go
  - app/backend/worker/crates/persistence/**
  - app/backend/worker/crates/worker/src/fakes.rs

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Extend existing job persistence to fix the encoding mode and safely commit an attempt-specific published manifest while retaining the established lease model.

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

**Preconditions / Dependencies:** `phase3-backlog-autoscaling` (`phase3-13-backlog-autoscaling.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## distributed-publication-state: Phase 3 Distributed Attempt and Publication State

depends_on: []

### Requirement

**Validation ownership:** Keep persistence, migration, pointer, and invalid-key tests in the existing Go/Rust application test suites under the allowed backend paths. Use the existing contract validator for shared-contract consistency; no Python contract-test file is required.

**Scope / Allowed Changes:** Add migration `0003_publication_state` for internal encoding_mode and nullable published_manifest_key. Keep existing rows compatible as legacy mode with a NULL pointer, and fix the initial mode in the acquisition transaction. Do not edit migrations 0001/0002 or add public statuses/JSON fields.

Add a Rust persistence operation that commits pointer and COMPLETED atomically with matching owner, attempt, unexpired lease, and PROCESSING predicates. Retain worker_id checks and reject delayed completion from an old attempt. Read the internal pointer through the Go repository; playback resolves only COMPLETED jobs and allowed relative keys belonging to that job. Legacy mode/NULL resolves the original key; distributed mode/NULL is invalid and must not be exposed.

Derive execution names from job UUID plus attempt. Reconstruct identical input within an attempt from persisted mode, profile version, and other required immutable values. The output attempt prefix must match execution identity. Add only the internal fields necessary for this contract; do not create a generic workflow table or independent job state machine.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Existing COMPLETED jobs play through CloudFront without moving their objects.
- Completion by an expired/different owner, different attempt, or already-COMPLETED job updates zero rows and leaves the pointer unchanged.
- Distributed success commits pointer and COMPLETED together; database failure leaves playback not-ready.
- Reject absolute URLs, another video/job's key, parent traversal, encoded traversal, and unknown profiles.
- Preserve CLI acquisition/release/completion and attempt budgets. Verify additive migration and legacy data compatibility on dedicated PostgreSQL.
- Rollback retains an API capable of reading published pointers; do not automatically drop columns needed to read distributed results.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml
python app/scripts/validate_contracts.py
```

**Live acceptance:** Set TEST_DATABASE_URL explicitly and verify concurrent acquisition and stale-attempt completion on real PostgreSQL. A skipped test due to missing database configuration is not acceptance.
