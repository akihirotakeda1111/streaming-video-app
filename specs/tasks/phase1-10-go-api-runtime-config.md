---
schema_version: 1
id: phase1-go-api-runtime-config
title: Phase 1 Go API Runtime and Configuration
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-runtime-config

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

Create the minimal Go API executable and typed runtime configuration after `phase1-infra-iam-outputs` has been merged into `dev`, treating `app/contracts/**` as fixed, read-only inputs.

# Non-Goals

- Do not add database migrations, repositories, HTTP endpoints, presigning, worker behavior, or frontend behavior.
- Do not implement authentication, retry, DLQ, CloudFront, or adaptive-bitrate behavior.
- Do not create, rewrite, or extend shared contracts or examples.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not hard-code bucket names, AWS credentials, database credentials, or public URLs.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-infra-iam-outputs` is a prerequisite and must already be merged into `dev`.
- Configuration supplies HTTP address, database URL, AWS region, input bucket, output bucket, and output S3 endpoint from the environment.
- The API remains stateless apart from future PostgreSQL and AWS calls.
- Upload completion remains owned by S3 `ObjectCreated:*`; the API never sends the encoding queue message.

# Tasks

## api-runtime-config: Create the executable and typed configuration

### Requirement

Create or complete the Go module, API entry point, and typed environment configuration with deterministic startup validation and test seams. Establish only the runtime skeleton needed by later database and HTTP tasks.

### Acceptance Criteria

- The module builds and has a single documented API entry point.
- Required configuration rejects missing or malformed values without exposing secrets.
- Input and output bucket values are distinct and configuration-driven.
- Startup wiring can receive later server and repository dependencies without package-global mutable state.
- Unit tests cover valid configuration and each required-value failure.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
