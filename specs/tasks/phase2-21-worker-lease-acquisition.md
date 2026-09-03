---
schema_version: 1
id: phase2-worker-lease-acquisition
title: Phase 2 Worker Lease Acquisition and Idempotency
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-worker-lease-acquisition

allowed_paths:
  - app/backend/worker/Cargo.toml
  - app/backend/worker/Cargo.lock
  - app/backend/worker/crates/worker/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/**
  - app/infra/**
  - app/backend/api/**
  - app/backend/worker/crates/persistence/**
  - app/backend/worker/crates/queue/**
  - app/backend/worker/crates/storage/**
  - app/backend/worker/crates/encoding/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Add the worker-side lease acquisition and duplicate-delivery decision boundary after `phase2-reliability-contract` and `phase2-job-lease-persistence` have been merged into `dev`.

# Non-Goals

- Do not schedule SQS/database heartbeats, download input, execute FFmpeg, upload HLS, classify processing failures, update terminal state, or delete a message.
- Do not change migrations, persistence SQL, queue adapters, storage/encoding adapters, infrastructure, contracts, API, or frontend.
- Do not introduce a second claim table, lock service, attempt table, or in-memory ownership source of truth.
- Do not acknowledge busy, completed, failed, invalid, or unknown records in this Task Spec.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, external adapters, frontend, docs, agent code, or GitHub Workflows.
- Do not treat Phase 1 zero-row initial claim as proof that the delivery is permanently ignorable; evaluate the typed lease state for recovery and duplicates.
- Do not generate a new `worker_id` for every message or record, and do not perform work before acquisition succeeds.
- If either prerequisite is not merged or the persistence adapter does not provide the required atomic typed outcomes, stop and escalate instead of recreating persistence logic in the worker crate.

# Architecture Invariants

- `phase2-reliability-contract` and `phase2-job-lease-persistence` are prerequisites and must already be merged into `dev`.
- Existing S3 event validation and the atomic `UPLOADING -> QUEUED` claim remain the entry path for a new upload.
- After the initial claim attempt, every canonical record is evaluated by the atomic lease-acquisition operation so expired `QUEUED`/`PROCESSING` work can recover.
- One stable `worker_id` is created once per worker process and injected into acquisition; it is not browser-visible or a database authority by itself.
- Only an acquired outcome may cross the side-effect boundary. Busy/unexpired, completed, failed, invalid, unknown, and persistence-error outcomes remain typed and distinct.
- Acquisition increments the persisted attempt exactly once; worker orchestration never increments it separately.

# Tasks

## worker-lease-acquisition: Convert notifications into typed ownership decisions

depends_on: []

### Requirement

Build a worker-side acquisition boundary that reuses Phase 1 event parsing and initial claim, invokes the Phase 2 atomic lease repository for every canonical record, and returns typed per-record dispositions containing acquired ownership data or the exact safe no-work reason. Add a stable per-process worker identity provider suitable for later runtime wiring.

### Acceptance Criteria

- A newly uploaded record is conditionally moved to `QUEUED` and then acquired through the repository; no separate read-before-write ownership check is added.
- A zero-row initial claim still evaluates lease state and can recover expired `QUEUED` or `PROCESSING` work.
- Acquired output contains job/video identity, current worker identity, persisted attempt, and lease expiry required by later processing.
- Busy/unexpired, already `COMPLETED`, terminal `FAILED`, unknown/mismatched, invalid-event, and persistence-error results remain distinguishable without side effects or message deletion.
- Two concurrent acquisition calls produce at most one acquired disposition for the same lease window.
- Reacquisition after expiry returns a later persisted attempt; completed and failed jobs are never acquired.
- One worker identity is stable across multiple messages in a process and distinct in deterministic test fixtures for competing workers.
- Tests prove no download, FFmpeg, upload, status completion/failure, visibility change, or DeleteMessage call occurs in this Task Spec.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml -p worker
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
