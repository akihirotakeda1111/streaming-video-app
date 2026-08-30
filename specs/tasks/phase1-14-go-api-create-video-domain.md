---
schema_version: 1
id: phase1-go-api-create-video-domain
title: Phase 1 Go API Video Creation Domain Flow
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-create-video-domain

allowed_paths:
  - app/backend/api/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/infra/**
  - app/backend/worker/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Implement validated video/job creation and canonical upload-key generation after `phase1-go-api-http-foundation` has been merged into `dev`.

# Non-Goals

- Do not implement AWS presigning or return a completed `POST /videos` response; that belongs to the next task.
- Do not upload source bytes, publish SQS messages, or implement status/playback endpoints.
- Do not create, rewrite, or extend shared contracts or examples.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not use the client file name in an S3 key or mark a job beyond `UPLOADING`.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-http-foundation` is a prerequisite and must already be merged into `dev`.
- Both identifiers are canonical lowercase UUIDs.
- The source key is exactly `videos/{video_id}/jobs/{job_id}/source.mp4`.
- One video and one `UPLOADING` job are persisted in one transaction before presigning.

# Tasks

## create-video-domain: Validate metadata and persist initial state

### Requirement

Implement request-domain validation, canonical identifier and key generation, and transactional persistence of one video with one `UPLOADING` job. Expose this behavior behind a service boundary for the later presigned-upload handler.

### Acceptance Criteria

- Only contract-valid `video/mp4` metadata and size values are accepted.
- Both IDs are canonical lowercase UUIDs.
- The stored source key is exact and never contains the client file name.
- Transaction failure leaves no video-only or job-only record.
- No AWS presign or SQS send operation occurs in this task.
- Tests cover valid input, each invalid metadata class, exact key generation, and rollback.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
