---
schema_version: 1
id: phase1-go-api-repository
title: Phase 1 Go API PostgreSQL Repository
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-repository

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

Implement the Go API PostgreSQL repository boundary after `phase1-go-api-database-schema` has been merged into `dev`.

# Non-Goals

- Do not implement HTTP handlers, request validation, S3 presigning, or worker-owned state transitions.
- Do not add caches, alternate databases, ORM-specific schema ownership, retry policy, or leases.
- Do not create, rewrite, or extend shared contracts or examples.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not expose repository methods that let the API write `QUEUED`, `PROCESSING`, or `COMPLETED`.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-database-schema` is a prerequisite and must already be merged into `dev`.
- Video and initial `UPLOADING` job creation is atomic.
- Reads return the current PostgreSQL state and do not derive status from S3.
- Repository errors distinguish not-found from storage failure without leaking credentials.

# Tasks

## api-repository: Implement transactional creation and reads

### Requirement

Implement repository interfaces and PostgreSQL operations for atomically creating one video with one `UPLOADING` job and reading the current video/job aggregate by canonical video ID.

### Acceptance Criteria

- Creation commits both records or neither record.
- Read results include metadata, job ID, status, failure details, and timestamps.
- Not-found is distinguishable from database failure.
- API-owned methods cannot advance worker-owned job states.
- Tests cover commit, rollback, read, and not-found behavior using deterministic repository seams.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
