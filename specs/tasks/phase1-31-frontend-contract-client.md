---
schema_version: 1
id: phase1-frontend-contract-client
title: Phase 1 Frontend Contract Client
status: PENDING
base_branch: dev
target_branch: feature/phase1-frontend-contract-client

allowed_paths:
  - app/frontend/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/infra/**
  - app/backend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Define contract-shaped frontend types and API client boundaries after `phase1-frontend-project-runtime` has been merged into `dev`.

# Non-Goals

- Do not build the workflow UI, send create requests, upload files, poll status, or initialize video.js.
- Do not generate or edit shared contracts.
- Do not add AWS SDKs, credentials, or client-side signing.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, agent code, or GitHub Workflows.
- Do not invent job statuses or response fields beyond the OpenAPI contract.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-frontend-project-runtime` is a prerequisite and must already be merged into `dev`.
- Client types represent create-video, video-status, playback, and documented errors.
- Networking remains behind injectable deterministic boundaries.
- Status is limited to the five contract values.

# Tasks

## frontend-contract-client: Define types and HTTP client boundaries

### Requirement

Implement TypeScript contract models, safe JSON/error parsing, URL construction from the configured API base, and injectable client interfaces for the three Phase 1 API operations.

### Acceptance Criteria

- Types match contract-required fields and five statuses.
- API paths resolve safely from configuration without hard-coded environments.
- Non-success and malformed responses become actionable typed errors.
- Tests use mocked fetch and cover success, contract errors, and invalid payloads.
- No live network request runs in unit tests.

### Validation

```text
npm --prefix app/frontend run test:unit -- --run
```

# Final Verification

```text
npm --prefix app/frontend run test:unit -- --run
```
