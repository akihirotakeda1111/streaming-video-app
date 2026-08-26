---
schema_version: 1
id: phase1-go-api-http-foundation
title: Phase 1 Go API HTTP Foundation
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-http-foundation

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

Create the HTTP server, route boundary, and common response handling after `phase1-go-api-repository` has been merged into `dev`.

# Non-Goals

- Do not implement create-video, status, or playback endpoint behavior.
- Do not add endpoints beyond the OpenAPI operations and a minimal health endpoint.
- Do not add authentication, upload proxying, SQS publishing, or worker behavior.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not expose internal errors, credentials, or environment details in HTTP responses.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-repository` is a prerequisite and must already be merged into `dev`.
- Routes use the `/api/v1` paths defined by the fixed OpenAPI contract.
- Error serialization is shared and contract-shaped.
- The health endpoint is side-effect-free and performs no S3, SQS, or encoding work.

# Tasks

## api-http-foundation: Create routing and common HTTP behavior

### Requirement

Implement server construction, route registration boundaries, common JSON/error helpers, request-size protections, and a side-effect-free health endpoint. Leave endpoint-specific behavior to later tasks.

### Acceptance Criteria

- The server starts and shuts down through explicit dependencies and context.
- Contract routes can be registered without package-global state.
- JSON and error responses use stable content types and shapes.
- Malformed JSON and oversized request bodies fail safely.
- Health checks do not enqueue, encode, or mutate job state.
- Unit tests cover routing, common errors, and health behavior.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
go test -C app/backend/api ./...
```
