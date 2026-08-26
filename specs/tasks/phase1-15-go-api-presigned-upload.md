---
schema_version: 1
id: phase1-go-api-presigned-upload
title: Phase 1 Go API Presigned Upload Endpoint
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-presigned-upload

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

Complete contract-conforming `POST /api/v1/videos` presigned upload behavior after `phase1-go-api-create-video-domain` has been merged into `dev`.

# Non-Goals

- Do not proxy source bytes, publish SQS messages, or implement status or playback endpoints.
- Do not sign arbitrary methods, keys, content types, or client-selected bucket names.
- Do not implement retries, multipart upload, authentication, or CloudFront.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not hard-code physical bucket names or AWS credentials.
- Do not return success when persistence or presigning fails.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-create-video-domain` is a prerequisite and must already be merged into `dev`.
- Presigning is limited to `PUT`, the canonical input key, and `Content-Type: video/mp4`.
- Upload state is persisted as `UPLOADING` before a successful response.
- S3 `ObjectCreated:*`, not the API, triggers the encoding queue.

# Tasks

## presigned-upload: Implement the create-video HTTP response and signer

### Requirement

Implement the S3 presigner boundary and `POST /api/v1/videos` handler, returning the exact method, required headers, expiry, video ID, job ID, status, and timestamps defined by OpenAPI.

### Acceptance Criteria

- Valid input returns `201` with a contract-conforming response.
- Invalid or malformed input returns the documented client error shape.
- The signer receives only the configured input bucket, exact canonical key, `PUT`, and `video/mp4`.
- No source bytes pass through the API and no SQS send occurs.
- Persistence or signer failures return an error without reporting a usable upload.
- Tests inspect signer inputs and validate success/error responses against contract examples.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
