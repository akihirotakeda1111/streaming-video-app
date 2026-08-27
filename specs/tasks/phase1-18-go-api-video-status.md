---
schema_version: 1
id: phase1-go-api-video-status
title: Phase 1 Go API Video Status Polling
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-video-status

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

Implement contract-conforming video status polling after `phase1-go-api-runtime-wiring` has been merged into `dev`.

# Non-Goals

- Do not implement playback resolution, derive state from S3, or mutate worker-owned states.
- Do not upload bytes, run FFmpeg, publish SQS messages, or add statuses.
- Do not create, rewrite, or extend shared contracts or examples.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not expose a playback URL from the status endpoint.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-runtime-wiring` is a prerequisite and must already be merged into `dev`.
- `GET /api/v1/videos/{videoId}` reads current state from PostgreSQL.
- Only the five contract statuses are serialized.
- `FAILED` carries contract-conforming failure details; other states do not invent failure data.

# Tasks

## video-status: Implement the status endpoint

### Requirement

Implement `GET /api/v1/videos/{videoId}` and serialize metadata, job state, failure details, and timestamps according to the OpenAPI contract.

### Acceptance Criteria

- Existing videos return `200` with the current PostgreSQL state.
- Unknown canonical UUIDs return the documented `404`.
- Malformed IDs return a documented client error without a database lookup.
- `FAILED` has non-empty failure details; non-`FAILED` follows contract null/omission behavior.
- Tests cover all five statuses, malformed IDs, and not-found.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
