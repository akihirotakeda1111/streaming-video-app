---
schema_version: 1
id: phase1-rust-worker-processing-download
title: Phase 1 Rust Worker Processing and Source Download
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-processing-download

allowed_paths:
  - app/backend/worker/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/infra/**
  - app/backend/api/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Move an owned job to `PROCESSING` and download its exact source after `phase1-rust-worker-atomic-claim` has been merged into `dev`.

# Non-Goals

- Do not invoke FFmpeg, upload HLS, mark terminal state, or delete SQS messages.
- Do not accept arbitrary bucket names, object keys, or local paths.
- Do not add retries, leases, heartbeats, or partial-output recovery.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not download unless claim ownership was obtained.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-atomic-claim` is a prerequisite and must already be merged into `dev`.
- The owned job moves `QUEUED -> PROCESSING` before source I/O.
- Bucket and key come from the validated notification and canonical contract.
- Source data is written only inside the job-specific temporary directory.

# Tasks

## processing-download: Transition state and fetch the source

### Requirement

For an owned claim, perform the guarded `QUEUED -> PROCESSING` transition, create an isolated work directory, and download the exact canonical source object to a fixed local source filename.

### Acceptance Criteria

- No processing begins without an owned claim.
- `PROCESSING` is durable before the S3 download starts.
- The configured input bucket and canonical event key are used unchanged.
- Local output cannot escape the job work directory.
- Tests assert state/download order, exact bucket/key, and failure behavior.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
