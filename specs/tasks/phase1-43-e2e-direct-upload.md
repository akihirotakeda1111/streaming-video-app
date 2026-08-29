---
schema_version: 1
id: phase1-e2e-direct-upload
title: Phase 1 E2E Browser Direct Upload
status: PENDING
base_branch: dev
target_branch: feature/phase1-e2e-direct-upload

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

Validate browser job creation and direct S3 upload after `phase1-e2e-preflight` has been merged into `dev`.

# Non-Goals

- Do not require terminal completion, inspect HLS, or assert playback.
- Do not bypass the Vue frontend or directly mutate database/output state.
- Do not repair application or infrastructure behavior.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, application code, infrastructure, agent code, or GitHub Workflows.
- Do not expose the presigned query string in reports.
- If behavior conflicts with a contract, report it instead of editing the application.

# Architecture Invariants

- `phase1-e2e-preflight` is a prerequisite and must already be merged into `dev`.
- The browser uses the Vue UI to create one video/job and upload the generated fixture.
- Video bytes go to the API-provided S3 URL, never the API/Vite upload origin.
- The test does not mutate PostgreSQL or HLS objects directly.

# Tasks

## e2e-direct-upload: Prove browser-to-S3 source upload

### Requirement

Add a `@phase1-pipeline` browser scenario that selects the generated MP4, creates one job through the UI, completes the presigned S3 upload, and records redacted network evidence and returned IDs for continuation.

### Acceptance Criteria

- Exactly one video/job is created from the UI.
- Upload uses API-provided `PUT` and required content type.
- Network evidence proves bytes target S3 and not API/Vite.
- Video and job IDs are retained without logging secrets.
- Create or upload failure fails before completion assertions.

### Validation

```text
npm --prefix app/frontend run test:e2e -- --grep @phase1-pipeline
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e -- --grep @phase1-pipeline
```
