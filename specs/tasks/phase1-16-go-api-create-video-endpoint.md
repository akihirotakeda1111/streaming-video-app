---
schema_version: 1
id: phase1-go-api-create-video-endpoint
title: Phase 1 Go API Create Video Endpoint
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-create-video-endpoint

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

Implement the contract-conforming create-video orchestration and HTTP endpoint after `phase1-go-api-s3-presigner` has been merged into `dev`.

# Non-Goals

- Do not wire concrete PostgreSQL or AWS clients into `cmd/api`; that belongs to `phase1-go-api-runtime-wiring`.
- Do not proxy source bytes, publish SQS messages, or implement status or playback endpoints.
- Do not add retries, multipart upload, authentication, CloudFront, or client-controlled object keys.
- Do not apply or change database migrations.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not persist a video or job when validation or presigning fails.
- Do not return a presigned URL when persistence fails.
- Do not log presigned URLs, query strings, AWS credentials, or database credentials.
- Do not return response statuses outside the create-video OpenAPI operation.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-s3-presigner` is a prerequisite and must already be merged into `dev`.
- Final Phase 1 ordering is `validate -> generate IDs/key/expiry -> presign -> transactionally persist video/job -> return 201`.
- This task refactors the temporary persistence-before-presigning flow introduced by `phase1-go-api-create-video-domain`; the final ordering above is authoritative.
- The database contains no new record when validation or signing fails.
- A persistence failure after signing does not return or log the unused URL.
- S3 `ObjectCreated:*`, not the API, triggers the encoding queue.

# Tasks

## create-video-endpoint: Orchestrate signing, persistence, and HTTP response

### Requirement

Refactor the existing creation service to prepare validated identifiers and upload metadata, presign before persistence, then atomically persist one video and one `UPLOADING` job. Implement and register `POST /api/v1/videos` using injected repository and presigner boundaries and serialize the exact OpenAPI response.

### Acceptance Criteria

- Valid JSON returns `201` with `videoId`, `job`, `upload`, and `createdAt` matching the OpenAPI contract.
- `upload` contains method `PUT`, the presigned URL, required `Content-Type: video/mp4`, the same expiry used for signing, and the configured bucket plus canonical object key.
- The response job is `UPLOADING` with no failure details.
- Invalid metadata, malformed JSON, unknown fields, and oversized request bodies return the documented `400` error shape and call neither signer nor repository.
- Signing failure returns the documented `500` shape and creates no database record.
- Persistence failure returns the documented `500` shape without returning or logging the presigned URL.
- The API performs no source upload and no SQS send.
- Tests assert `validate -> presign -> persist -> respond` call order, route registration, contract examples, and every error boundary with fakes.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
