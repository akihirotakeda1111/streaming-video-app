---
schema_version: 1
id: phase1-go-api-database-schema
title: Phase 1 Go API Database Schema
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-database-schema

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

Define the Phase 1 PostgreSQL schema and Go persistence models after `phase1-go-api-runtime-config` has been merged into `dev`.

# Non-Goals

- Do not implement repository queries, HTTP endpoints, S3 presigning, or worker state transitions.
- Do not add statuses, retries, leases, or lifecycle events beyond the fixed contracts.
- Do not create, rewrite, or extend shared contracts or examples.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not weaken relational or status constraints to accommodate invalid data.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-runtime-config` is a prerequisite and must already be merged into `dev`.
- PostgreSQL is the source of truth for video and encoding-job state.
- The schema supports only `UPLOADING`, `QUEUED`, `PROCESSING`, `COMPLETED`, and `FAILED`.
- One Phase 1 video has exactly one encoding job, including optional failure details and timestamps.

# Tasks

## api-database-schema: Define migrations and persistence models

### Requirement

Add reversible PostgreSQL migrations and matching Go models for one video and one encoding job, including canonical identifiers, upload metadata, status, failure details, and timestamps required by the API and worker.

### Acceptance Criteria

- Up and down migrations define the complete Phase 1 schema.
- The database constrains status values to the five contract values.
- A job references exactly one video and preserves referential integrity.
- Failure details can be stored for `FAILED` without inventing extra lifecycle states.
- Tests verify migration structure and model/status mappings.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
