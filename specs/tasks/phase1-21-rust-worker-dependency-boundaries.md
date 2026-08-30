---
schema_version: 1
id: phase1-rust-worker-dependency-boundaries
title: Phase 1 Rust Worker Dependency Boundaries
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-dependency-boundaries

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

Define deterministic worker boundaries after `phase1-rust-worker-project-config` has been merged into `dev`.

# Non-Goals

- Do not implement production AWS/PostgreSQL adapters, polling, parsing, encoding, publication, or terminal state changes.
- Do not contact live AWS or PostgreSQL services from tests.
- Do not add Phase 2 lifecycle machinery.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not couple core processing logic directly to SDK clients or shell strings.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-project-config` is a prerequisite and must already be merged into `dev`.
- Queue, storage, database, clock, and process execution remain behind testable boundaries.
- Process execution accepts an executable and argv list, never an interpolated shell command.
- Message deletion is a distinct operation reserved for terminal success.

# Tasks

## worker-dependency-boundaries: Define ports and deterministic fakes

### Requirement

Define focused interfaces for SQS receive/delete, S3 read/write, job state operations, time, and process execution, plus deterministic worker-owned fakes for later unit tests.

### Acceptance Criteria

- Core orchestration can compile without concrete AWS or PostgreSQL clients.
- Process execution represents FFmpeg arguments as an argv list.
- Queue receive and delete are separate capabilities.
- Database capabilities distinguish claim, processing, completed, and failed transitions.
- Fakes can record call order and inject failures without live services.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
