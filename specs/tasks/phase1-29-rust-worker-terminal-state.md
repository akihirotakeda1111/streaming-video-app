---
schema_version: 1
id: phase1-rust-worker-terminal-state
title: Phase 1 Rust Worker Terminal State and Message Completion
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-terminal-state

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

Complete worker terminal state and SQS acknowledgement ordering after `phase1-rust-worker-publish-hls` has been merged into `dev`.

# Non-Goals

- Do not add retry orchestration, DLQ handling, leases, heartbeats, autoscaling, or full crash recovery.
- Do not republish completed jobs or introduce custom lifecycle events.
- Do not change encoding or storage contracts.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not mark `COMPLETED` before manifest success or delete before durable completion.
- Do not overwrite a job already in `COMPLETED`.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-publish-hls` is a prerequisite and must already be merged into `dev`.
- Ordering is `claim -> PROCESSING -> download -> encode -> segments -> manifest -> COMPLETED -> delete`.
- An unrecoverable owned processing failure may be recorded as `FAILED` without adding retry policy.
- Duplicate notifications and zero-row claims do not delete another worker's message as completed work.

# Tasks

## terminal-state: Commit completion or failure and acknowledge safely

### Requirement

Wire the full message processor so `COMPLETED` is written only after manifest publication, SQS deletion occurs only after durable completion, owned unrecoverable failures become `FAILED`, and job temporary data is cleaned up.

### Acceptance Criteria

- `COMPLETED` follows successful manifest upload.
- Message deletion follows successful `COMPLETED` persistence.
- Failures cannot produce both completion and deletion.
- Owned unrecoverable failures contain non-empty failure details.
- Temporary data is removed after success or handled failure.
- Tests assert full call order, duplicate no-op behavior, and each failure boundary.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
python app/scripts/validate_contracts.py
cargo test --manifest-path app/backend/worker/Cargo.toml
```
