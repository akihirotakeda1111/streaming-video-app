---
schema_version: 1
id: phase1-rust-worker-project-config
title: Phase 1 Rust Worker Project and Configuration
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-project-config

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

Create the minimal Rust worker project and typed configuration after `phase1-go-api-playback` and `phase1-infra-iam-outputs` have been merged into `dev`.

# Non-Goals

- Do not implement dependency adapters, SQS polling, event parsing, claims, encoding, publication, or message deletion.
- Do not add retry orchestration, leases, heartbeats, DLQ handling, or autoscaling.
- Do not create, rewrite, or extend shared contracts or examples.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not hard-code AWS or database credentials.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-playback` and `phase1-infra-iam-outputs` are prerequisites and must already be merged into `dev`.
- Configuration supplies PostgreSQL, region, queue URL, input/output buckets, FFmpeg path, and temporary directory.
- Phase 1 uses one bounded worker process with no lease, heartbeat, or retry scheduler.
- Contract files remain authoritative and read-only.

# Tasks

## worker-project-config: Create the executable and typed configuration

### Requirement

Create or complete the Rust crate, worker entry point, typed environment configuration, and structured logging setup without connecting to external services.

### Acceptance Criteria

- The crate builds and has one documented worker entry point.
- Required configuration rejects missing or malformed values without exposing secrets.
- Input and output buckets are required and distinct.
- Startup supports graceful cancellation and structured, secret-safe logs.
- Tests cover valid configuration and required-value failures.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
