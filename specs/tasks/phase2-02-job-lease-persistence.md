---
schema_version: 1
id: phase2-job-lease-persistence
title: Phase 2 Job Lease Persistence
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-job-lease-persistence

allowed_paths:
  - app/backend/api/**
  - app/backend/worker/crates/persistence/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/**
  - app/infra/**
  - app/backend/worker/crates/queue/**
  - app/backend/worker/crates/storage/**
  - app/backend/worker/crates/encoding/**
  - app/backend/worker/crates/worker/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Add the PostgreSQL lease and attempt state required by `phase2-reliability-contract` after that Task Spec has been merged into `dev`, while preserving all Phase 1 API reads and job creation behavior.

# Non-Goals

- Do not orchestrate SQS receipt handling, heartbeat scheduling, retry delays, FFmpeg, S3 publication, or message deletion.
- Do not change the OpenAPI contract, frontend models, job status enum, or canonical storage keys.
- Do not expose worker ownership, lease expiry, or attempt counters through the Go API.
- Do not introduce a separate jobs table, event-sourcing model, retry table, or distributed lock service.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, queue/storage/encoding/worker orchestration code, frontend, agent code, or GitHub Workflows.
- Do not implement lease acquisition as a read-then-write sequence.
- Do not permit a stale or different worker to renew, release, complete, or fail the current attempt.
- Do not make the Phase 1 migration destructive or rewrite it in place; add a reversible Phase 2 migration.
- If `phase2-reliability-contract` is not merged or its ownership rules cannot be represented atomically in PostgreSQL, stop and escalate.

# Architecture Invariants

- `phase2-reliability-contract` is a prerequisite and must already be merged into `dev`.
- PostgreSQL remains the source of truth for job state and active processing ownership.
- Phase 1 rows migrate safely with no active owner, zero attempts, and no lease expiry.
- The existing `UPLOADING -> QUEUED` conditional claim is preserved.
- Lease acquisition accepts only `QUEUED` or recoverable expired `PROCESSING`, assigns one worker, moves the job to `PROCESSING`, and increments `attempt` in the same statement.
- Lease renewal, retry release, completion, and final failure are conditional on both job ID and current worker ownership.
- Completion and final failure clear lease ownership atomically; `COMPLETED` and `FAILED` remain terminal.
- The Go API continues to select only browser-facing fields and returns the same response shapes as Phase 1.

# Tasks

## job-lease-persistence: Add migration and atomic lease repository operations

depends_on: []

### Requirement

Add a reversible Phase 2 migration for the minimum lease model and replace the worker persistence port and PostgreSQL adapter with typed atomic outcomes for initial claim, lease acquisition, renewal, retry release, durable completion, and terminal failure. Keep API persistence compatible with the additional columns and the unchanged public model.

### Acceptance Criteria

- The Phase 2 migration adds nullable `worker_id` and `lease_expires_at` plus a non-negative `attempt` with a safe default for existing rows.
- Schema constraints prevent partial lease ownership, negative attempts, and lease metadata on terminal rows.
- One conditional statement acquires an unowned/expired `QUEUED` or `PROCESSING` job, sets `PROCESSING`, and increments `attempt` exactly once.
- Concurrent acquisition tests prove that only one worker receives ownership for the same lease window.
- Renewal succeeds only for the current unexpired owner; retry release, completion, and final failure reject stale owners.
- Reacquisition after expiry succeeds and increments `attempt`; acquisition of active, `COMPLETED`, `FAILED`, unknown, or mismatched jobs returns a typed non-owner outcome without overwriting state.
- Retry release returns an owned `PROCESSING` job to `QUEUED`, clears lease fields, and leaves public failure fields empty.
- Completion and terminal failure clear lease fields and preserve the existing failure-detail constraint.
- Go API repository and integration tests prove Phase 1 create/status/playback behavior is unchanged after both migrations.

### Validation

```text
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml -p persistence
```

# Final Verification

```text
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml -p persistence
```
