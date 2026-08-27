---
schema_version: 1
id: phase1-rust-worker-parse-event
title: Phase 1 Rust Worker S3 Event Parsing
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-parse-event

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

Parse every S3 Event Notification record delivered through SQS after `phase1-rust-worker-sqs-loop` has been merged into `dev`.

# Non-Goals

- Do not claim jobs, download source, invoke FFmpeg, upload output, or delete messages.
- Do not accept unsupported events or noncanonical keys.
- Do not add Phase 2 lifecycle machinery.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not let one malformed record suppress other records in the same message.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-sqs-loop` is a prerequisite and must already be merged into `dev`.
- Every `Records` item is evaluated independently.
- Supported `ObjectCreated:*` names are accepted, keys are form-decoded, and the configured input bucket is verified.
- Only `videos/{video_id}/jobs/{job_id}/source.mp4` with canonical UUIDs is eligible.

# Tasks

## parse-event: Parse and validate every notification record

### Requirement

Parse standard S3 notifications from SQS, evaluate all records, form-decode keys, verify event and bucket, enforce the exact source-key pattern, and extract canonical video and job IDs.

### Acceptance Criteria

- The canonical contract fixture produces the expected work item.
- Multi-record messages evaluate every record independently.
- Wrong bucket, unsupported event, `s3:TestEvent`, malformed UUID, wrong prefix/suffix, and extra path components are rejected safely.
- Form decoding handles `+` and percent-encoded values before validation.
- Tests assert all-record behavior and exact ID extraction.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
