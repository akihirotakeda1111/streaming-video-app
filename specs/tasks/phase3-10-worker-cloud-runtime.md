---
schema_version: 1
id: phase3-worker-cloud-runtime
title: Phase 3 Worker TLS and Safe Horizontal Runtime
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-worker-cloud-runtime

allowed_paths:
  - app/backend/worker/**
  - app/backend/api/internal/config/**
  - app/backend/api/internal/bootstrap/**
  - app/backend/api/cmd/api/**
  - app/backend/api/go.mod
  - app/backend/api/go.sum
  - app/compose.yaml
  - app/.env.example
  - app/docs/runbooks/worker-scaling.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Prepare the existing worker for multiple Fargate instances with verified database TLS, bounded concurrency, scale-in protection, and safe shutdown.

**Priority:** P1. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.


# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validator and component tests. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** `phase3-delivery-e2e` (`phase3-04-delivery-e2e.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## worker-cloud-runtime: Phase 3 Worker TLS and Safe Horizontal Runtime

depends_on: []

### Requirement

**Scope / Allowed Changes:** Replace the Rust PostgreSQL adapter's fixed NoTls connection with CA- and hostname-verified TLS support. Retain explicit non-TLS local Compose operation; never fall back after a cloud TLS failure. Check TLS configuration propagation through the existing Go API driver. Replace fixed `PHASE1_MAX_CONCURRENCY=2` with bounded configuration retaining the local default, and configure Fargate initially at one. Bound database connections, FFmpeg threads, source size/duration, ephemeral storage, and wall time.

In ECS service mode, acquire task scale-in protection before receiving work and renew it before expiry. Coordinate outstanding receives and active work to avoid protection races. Release protection only with no active work, and stop new receives if protection cannot be acquired. After an empty receive, release protection for a bounded idle interval so idle tasks do not remain continuously protected. Preserve shutdown behavior: stop receiving, cancel heartbeat/FFmpeg work, and join within a bound without acknowledging incomplete messages. Protection does not prevent crashes or forced stops; existing lease expiry and redelivery remain the recovery mechanism.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Reject invalid CAs, hostname mismatches, and expired certificates. Permit NoTls only in explicitly local configuration.
- Reuse acquisition/heartbeat tests to show that two or more distinct worker identities produce one valid owner for the same job and increment attempts only on successful acquisition.
- Test concurrency limits, protection renewal/expiry/failure, idle release, SIGTERM, and actual FFmpeg child termination.
- Use ECS task-role credential discovery without injecting static cloud access keys.
- Preserve API/local configuration compatibility and existing database transaction/lease predicates.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
go test -C app/backend/api ./...
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
go test -C app/backend/api ./...
python app/scripts/validate_contracts.py
```

**Live acceptance:** Set TEST_DATABASE_URL explicitly for dedicated PostgreSQL race and lease tests, and verify a TLS database connection. Skipped database tests do not satisfy live acceptance.
