---
schema_version: 1
id: phase1-go-api-s3-presigner
title: Phase 1 Go API S3 Presigner Boundary
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-s3-presigner

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

Implement the isolated S3 presigner boundary required by the create-video endpoint after `phase1-go-api-create-video-domain` has been merged into `dev`.

# Non-Goals

- Do not implement or register an HTTP handler.
- Do not create or update PostgreSQL records.
- Do not wire the production API runtime; that belongs to `phase1-go-api-runtime-wiring`.
- Do not proxy source bytes, publish SQS messages, implement retries, use multipart upload, or add authentication or CloudFront.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not sign arbitrary methods, buckets, keys, content types, or client-selected headers.
- Do not hard-code physical bucket names, AWS credentials, or region-specific public URLs.
- Do not log or expose a presigned URL or its query string outside the returned signer result.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-create-video-domain` is a prerequisite and must already be merged into `dev`.
- Presigning is limited to S3 `PutObject` for the configured input bucket and canonical source key.
- The signed request requires `Content-Type: video/mp4` and uses a Phase 1 expiry of 15 minutes.
- AWS credentials come from the standard AWS credential provider chain.
- Signing is side-effect-free: it does not write S3 objects, PostgreSQL records, or SQS messages.

# Tasks

## s3-presigner: Implement the presigner interface and AWS adapter

### Requirement

Define an injectable upload-presigner interface and implement its AWS S3 adapter. The adapter must produce a presigned `PUT` request for the configured input bucket, exact canonical source key, required `Content-Type: video/mp4` header, and 15-minute expiry without contacting live AWS from tests.

### Acceptance Criteria

- The interface accepts bucket, key, content type, and expiry duration as explicit inputs.
- The AWS adapter presigns only S3 `PutObject` and returns method `PUT`, URL, and required headers.
- The adapter rejects an empty bucket, noncanonical source key, non-`video/mp4` content type, and nonpositive expiry before calling the SDK boundary.
- The canonical key is `videos/{video_id}/jobs/{job_id}/source.mp4` with canonical lowercase UUIDs.
- No database, HTTP route, SQS, or object-write behavior is introduced.
- Unit tests inspect SDK inputs through a fake presign client and verify errors without live AWS access.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
