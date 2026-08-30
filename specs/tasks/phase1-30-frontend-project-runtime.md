---
schema_version: 1
id: phase1-frontend-project-runtime
title: Phase 1 Frontend Project Runtime
status: PENDING
base_branch: dev
target_branch: feature/phase1-frontend-project-runtime

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

Create the Vue 3, TypeScript, Vite, and test runtime after `phase1-rust-worker-terminal-state` has been merged into `dev`.

# Non-Goals

- Do not implement contract clients, workflow UI, upload, polling, or playback behavior.
- Do not proxy API or media traffic or embed AWS credentials.
- Do not replace Vue/Vite or modify contracts.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, agent code, or GitHub Workflows.
- Do not hard-code physical bucket names or environment-specific API URLs.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-terminal-state` is a prerequisite and must already be merged into `dev`.
- Runtime configuration supplies the API base URL and no AWS credentials.
- Vue 3, TypeScript, and Vite remain the frontend platform.
- Unit tests run without live API, S3, timers, or media services.

# Tasks

## frontend-project-runtime: Create the application and test skeleton

### Requirement

Create or complete the frontend package, Vue/Vite entry point, runtime API-base configuration, base styling, and Vitest environment. Add video.js as a dependency without initializing a player.

### Acceptance Criteria

- Development and test entry points start from package scripts.
- API base URL is supplied by Vite environment configuration.
- Source contains no AWS credentials or physical bucket names.
- Vitest can mount a minimal root component offline.
- video.js is installed but no playback behavior is implemented.

### Validation

```text
npm --prefix app/frontend run test:unit -- --run
```

# Final Verification

```text
npm --prefix app/frontend run test:unit -- --run
```
