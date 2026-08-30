---
schema_version: 1
id: phase1-rust-worker-runtime-adapters
title: Phase 1 Rust Worker Runtime Adapters
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-runtime-adapters

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

Implement concrete AWS, PostgreSQL, filesystem, and process adapters after `phase1-rust-worker-dependency-boundaries` has been merged into `dev`.

# Non-Goals

- Do not implement SQS orchestration, event semantics, job claims, encoding flow, publication ordering, or message deletion decisions.
- Do not contact live services from tests or embed credentials.
- Do not add retries, leases, heartbeats, or DLQ behavior.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not use shell interpolation for process execution.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-dependency-boundaries` is a prerequisite and must already be merged into `dev`.
- AWS clients use configured region, queue URL, and buckets.
- PostgreSQL uses the schema established by the Go API tasks.
- Temporary work is isolated under the configured directory.

# Tasks

## worker-runtime-adapters: Implement external service adapters

### Requirement

Implement the production adapters for SQS, S3, PostgreSQL, per-job temporary directories, and argv-based process execution, while keeping all unit tests offline through the existing boundaries.

### Acceptance Criteria

- AWS adapters use configured resources and default credential resolution without hard-coded secrets.
- PostgreSQL adapter maps the five contract statuses and required identifiers.
- Temporary directories are isolated per job and safely removable.
- Process execution invokes an executable with an argv vector.
- Adapter tests use fakes or local deterministic seams and never call live AWS.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
