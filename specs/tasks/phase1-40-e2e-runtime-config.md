---
schema_version: 1
id: phase1-e2e-runtime-config
title: Phase 1 E2E Runtime Configuration
status: PENDING
base_branch: dev
target_branch: feature/phase1-e2e-runtime-config

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

Create the Playwright E2E runtime boundary after `phase1-frontend-production-build`, `phase1-rust-worker-terminal-state`, and the manually verified Phase 1 infrastructure have been merged into `dev`.

# Non-Goals

- Do not implement fixtures, preflight, upload, status, HLS, or playback scenarios.
- Do not implement or repair application or infrastructure code.
- Do not provision, mutate, or destroy infrastructure.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, frontend source, agent code, or GitHub Workflows.
- Do not use production credentials or execute Terraform/AWS mutation commands.
- If behavior conflicts with a contract, report it instead of editing the application.

# Architecture Invariants

- All implementation prerequisites and human Terraform verification are complete before E2E work.
- Tests target an explicitly configured disposable Phase 1 environment.
- Upload, processing, and playback waits are bounded.
- Repository files contain no environment secrets.

# Tasks

## e2e-runtime-config: Configure Playwright and typed environment input

### Requirement

Create or complete Playwright configuration, package scripts, typed E2E environment parsing, project selection, and bounded timeout defaults without defining a business-flow test.

### Acceptance Criteria

- Frontend and API public endpoints are required through environment configuration.
- Missing or invalid configuration fails before browser actions.
- Timeouts separately bound navigation, upload, processing, and playback.
- Configuration is suitable only for an explicitly disposable environment.
- A minimal harness test can load without running the Phase 1 pipeline.

### Validation

```text
npm --prefix app/frontend run test:e2e -- --list
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e -- --list
```
