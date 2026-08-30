---
schema_version: 1
id: phase1-e2e-fixture-diagnostics
title: Phase 1 E2E Fixture and Safe Diagnostics
status: PENDING
base_branch: dev
target_branch: feature/phase1-e2e-fixture-diagnostics

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

Add deterministic media fixture and secret-safe diagnostics after `phase1-e2e-runtime-config` has been merged into `dev`.

# Non-Goals

- Do not run browser preflight or pipeline assertions.
- Do not store copyrighted/user media, credentials, or presigned query strings.
- Do not mutate application or infrastructure code.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, application code, infrastructure, agent code, or GitHub Workflows.
- Do not log secrets or full presigned URLs.
- If behavior conflicts with a contract, report it instead of editing the application.

# Architecture Invariants

- `phase1-e2e-runtime-config` is a prerequisite and must already be merged into `dev`.
- A small deterministic MP4 is generated locally with FFmpeg and removed after use.
- Logs, traces, screenshots, and reports redact credentials and URL query strings.
- Non-secret video/job IDs remain available for diagnosis.

# Tasks

## e2e-fixture-diagnostics: Generate media and redact artifacts

### Requirement

Implement local deterministic MP4 generation, cleanup, redacted URL/log helpers, and safe diagnostic attachment utilities for later Playwright scenarios.

### Acceptance Criteria

- Fixture generation uses local FFmpeg and produces a small valid `video/mp4` file.
- Generated files are isolated and removed after the run.
- Presigned query strings and credential-like values are redacted from text artifacts.
- Safe diagnostics preserve origin, path, status, and non-secret IDs.
- Unit-level helper tests cover generation metadata, cleanup, and redaction.

### Validation

```text
npm --prefix app/frontend run test:e2e -- --list
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e -- --list
```
