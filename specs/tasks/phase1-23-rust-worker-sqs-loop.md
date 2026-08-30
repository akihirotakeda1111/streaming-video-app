---
schema_version: 1
id: phase1-rust-worker-sqs-loop
title: Phase 1 Rust Worker SQS Runtime Loop
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-sqs-loop

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

Create the bounded SQS long-poll runtime after `phase1-rust-worker-runtime-adapters` has been merged into `dev`.

# Non-Goals

- Do not implement S3 event parsing, claims, downloads, encoding, publication, or success deletion behavior.
- Do not add visibility heartbeats, retry scheduling, DLQ consumption, or autoscaling.
- Do not create multiple concurrent worker pools.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not delete messages merely because they were received.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-runtime-adapters` is a prerequisite and must already be merged into `dev`.
- SQS uses long polling with bounded Phase 1 concurrency.
- A received message is handed to a replaceable processor boundary.
- Shutdown stops new receives and allows bounded in-flight cleanup.

# Tasks

## worker-sqs-loop: Implement bounded long polling

### Requirement

Implement the SQS receive loop, cancellation behavior, bounded concurrency, per-message dispatch boundary, and worker container packaging with explicitly versioned FFmpeg and ffprobe availability.

### Acceptance Criteria

- Long polling uses a nonzero wait time and configured queue URL.
- Concurrency is explicitly bounded for one Phase 1 worker deployment.
- Receive failures are surfaced without adding a retry scheduler.
- Message deletion is not performed by the receive loop itself.
- The container can execute documented FFmpeg and ffprobe binaries.
- Tests cover empty receives, dispatch, cancellation, and concurrency bounds.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
