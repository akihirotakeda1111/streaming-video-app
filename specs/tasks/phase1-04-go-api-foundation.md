---
schema_version: 1
id: phase1-go-api-foundation
title: Phase 1 Go API Foundation
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-foundation

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

Create the Go API runtime, configuration, persistence, and routing foundation for the Phase 1 normal path after `phase1-infra-iam-outputs` has been merged into `dev`, treating `app/contracts/**` as fixed, read-only inputs.

# Non-Goals

- Do not implement the create-video, status-polling, or playback endpoint behavior beyond the foundation required to route and test them.
- Do not upload source video bytes through the API, run FFmpeg, publish SQS messages, or emit custom encoding lifecycle events.
- Do not implement authentication, rate limiting, cancellation, retry, lease, heartbeat, DLQ, CloudFront, or adaptive-bitrate behavior.
- Do not create, rewrite, or extend shared contracts or their examples.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, shared contracts, infrastructure, worker, frontend, Execution State, agent runtime code, or GitHub Workflows.
- Do not hard-code physical bucket names, AWS credentials, database credentials, or environment-specific public URLs.
- Do not mark a job `QUEUED`, `PROCESSING`, or `COMPLETED` from the API.
- If implementation requirements conflict with an existing contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-infra-iam-outputs` is a prerequisite and must already be merged into `dev`.
- `app/contracts/openapi/api.yaml`, `app/contracts/domain/job-status.schema.json`, `app/contracts/domain/storage-conventions.md`, and `app/contracts/examples/**` are authoritative and read-only.
- PostgreSQL is the source of truth for video and encoding-job state.
- The database supports the five contract statuses and transactional creation of one video with one job.
- The service remains stateless apart from PostgreSQL and AWS service calls.
- Upload completion remains owned by S3 `ObjectCreated:*`; the API never sends the encoding queue message.

# Tasks

## api-foundation: Create service, configuration, and persistence foundation

### Requirement

Create or complete the Go service, typed runtime configuration, HTTP routing, PostgreSQL migrations, repository layer, and minimal health endpoint required by the Phase 1 infrastructure. The schema must support one video, one encoding job, all five contract statuses, failure details, timestamps, and the identifiers required by both API and worker.

### Acceptance Criteria

- The service starts from environment-provided HTTP, database, region, input-bucket, and output-bucket configuration.
- Migrations create video and job records with canonical IDs, metadata, status, optional failure details, and timestamps.
- The database constrains status values to the five values in `job-status.schema.json`.
- A job references exactly one video in Phase 1, and creation can be committed transactionally.
- The health endpoint is side-effect-free and does not enqueue or encode work.
- Unit tests cover configuration validation, migration expectations, and repository create/read behavior.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
