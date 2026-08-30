---
schema_version: 1
id: phase1-e2e-preflight
title: Phase 1 E2E Environment Preflight
status: PENDING
base_branch: dev
target_branch: feature/phase1-e2e-preflight

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

Implement a non-mutating environment preflight after `phase1-e2e-fixture-diagnostics` has been merged into `dev`.

# Non-Goals

- Do not create video jobs, upload media, wait for processing, or test playback.
- Do not provision or repair the environment.
- Do not run Terraform or AWS mutation commands.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, application code, infrastructure, agent code, or GitHub Workflows.
- Do not use production credentials or create persistent data.
- If behavior conflicts with a contract, report it instead of editing the application.

# Architecture Invariants

- `phase1-e2e-fixture-diagnostics` is a prerequisite and must already be merged into `dev`.
- Preflight is tagged `@preflight` and is safe to repeat.
- It validates frontend, API health, browser, and local FFmpeg availability.
- It does not create a video or mutate job state.

# Tasks

## e2e-preflight: Verify required runtime dependencies

### Requirement

Add the `@preflight` scenario to verify configured frontend reachability, side-effect-free API health, browser operation, and local FFmpeg fixture capability before E2E pipeline execution.

### Acceptance Criteria

- Frontend and API health respond within bounded timeouts.
- Browser execution and fixture generation are verified.
- No create-video request, S3 upload, or job record is produced.
- Failure identifies the unavailable dependency without exposing secrets.
- The preflight can be run independently by tag.

### Validation

```text
npm --prefix app/frontend run test:e2e -- --grep @preflight
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e -- --grep @preflight
```
