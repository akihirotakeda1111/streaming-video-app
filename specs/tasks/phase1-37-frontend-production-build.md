---
schema_version: 1
id: phase1-frontend-production-build
title: Phase 1 Frontend Production Build
status: PENDING
base_branch: dev
target_branch: feature/phase1-frontend-production-build

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

Complete the deployable Phase 1 frontend after `phase1-frontend-hls-playback` has been merged into `dev`.

# Non-Goals

- Do not add features beyond upload, polling, and playback.
- Do not embed environment-specific URLs, bucket names, credentials, CloudFront, analytics, or authentication.
- Do not modify infrastructure, backend, or contracts.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, agent code, or GitHub Workflows.
- Do not use mutating lint-fix commands or weaken checks.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-frontend-hls-playback` is a prerequisite and must already be merged into `dev`.
- Deployment supplies the API base URL.
- Production assets include video.js styles and controls.
- Validation commands are non-mutating.

# Tasks

## frontend-production-build: Complete quality checks and build

### Requirement

Complete non-mutating lint, type-check, unit-test, and production-build setup without embedding environment-specific API or S3 values.

### Acceptance Criteria

- Unit tests, type checking, and lint pass without rewriting source.
- The Vite production build succeeds.
- Runtime configuration supplies the API base URL.
- Source has no AWS keys, secrets, or physical bucket names.
- Built assets include video.js styling and controls.

### Validation

```text
npm --prefix app/frontend run test:unit -- --run
npm --prefix app/frontend run type-check
npm --prefix app/frontend run lint
npm --prefix app/frontend run build
```

# Final Verification

```text
python app/scripts/validate_contracts.py
npm --prefix app/frontend run test:unit -- --run
npm --prefix app/frontend run type-check
npm --prefix app/frontend run lint
npm --prefix app/frontend run build
```
