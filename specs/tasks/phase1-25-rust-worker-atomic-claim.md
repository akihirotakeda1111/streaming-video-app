---
schema_version: 1
id: phase1-rust-worker-atomic-claim
title: Phase 1 Rust Worker Atomic Job Claim
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-atomic-claim

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

Implement the atomic `UPLOADING -> QUEUED` claim after `phase1-rust-worker-parse-event` has been merged into `dev`.

# Non-Goals

- Do not download, encode, publish, complete, fail, or delete a message.
- Do not add leases, heartbeats, retry orchestration, DLQ behavior, or crash recovery.
- Do not overwrite jobs outside `UPLOADING`.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not implement claim as read-then-write or continue unless exactly one row changes.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-parse-event` is a prerequisite and must already be merged into `dev`.
- Claim is one conditional update scoped by video ID, job ID, and `UPLOADING`.
- One affected row owns work; zero rows is a safe no-op.
- Duplicate notifications and completed jobs remain safe no-ops.

# Tasks

## atomic-claim: Claim the upload exactly once

### Requirement

Implement and wire a repository operation that conditionally updates `UPLOADING` to `QUEUED` and permits downstream work only when exactly one row is affected.

### Acceptance Criteria

- Claim uses one conditional SQL statement.
- Exactly one concurrent claimant can own the same job.
- Missing, mismatched, or non-`UPLOADING` jobs return a zero-row no-op.
- Zero-row claims cause no download, process, upload, state overwrite, or delete.
- Tests cover concurrent claims and duplicate completed notifications.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
