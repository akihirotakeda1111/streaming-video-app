---
schema_version: 1
id: phase1-e2e-pipeline-completion
title: Phase 1 E2E Asynchronous Pipeline Completion
status: PENDING
base_branch: dev
target_branch: feature/phase1-e2e-pipeline-completion

allowed_paths:
  - app/frontend/e2e/**
  - app/frontend/playwright.config.ts
  - app/frontend/package.json
  - app/frontend/package-lock.json

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/infra/**
  - app/backend/**
  - app/frontend/src/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Validate asynchronous completion after `phase1-e2e-direct-upload` has been merged into `dev`.

# Non-Goals

- Do not validate manifest contents, segments, CORS, or actual playback.
- Do not directly query/mutate PostgreSQL or write output objects.
- Do not implement retries or repair system behavior.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, application code, infrastructure, agent code, or GitHub Workflows.
- Do not treat upload success alone as pipeline success.
- If behavior conflicts with a contract, report it instead of editing the application.

# Architecture Invariants

- `phase1-e2e-direct-upload` is a prerequisite and must already be merged into `dev`.
- Completion occurs through real S3 `ObjectCreated -> SQS -> Worker -> PostgreSQL` behavior.
- Polling is bounded and reports the last observed status.
- `FAILED` is terminal and fails the scenario.

# Tasks

## e2e-pipeline-completion: Prove terminal completed state

### Requirement

Continue the browser scenario after direct upload and wait until the UI and API report `COMPLETED`, recording intermediate state when observable and validating the completed response contract.

### Acceptance Criteria

- The returned video/job reaches `COMPLETED` within the configured timeout.
- `QUEUED` or `PROCESSING` is recorded when observable but neither is required if polling misses it.
- Terminal `FAILED` immediately fails with redacted failure diagnostics.
- Completed response has no failure details and matches contract expectations.
- Timeout reports last status and non-secret IDs.

### Validation

```text
npm --prefix app/frontend run test:e2e -- --grep @phase1-pipeline
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e -- --grep @phase1-pipeline
```
