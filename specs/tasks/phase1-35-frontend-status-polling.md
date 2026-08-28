---
schema_version: 1
id: phase1-frontend-status-polling
title: Phase 1 Frontend Job Status Polling
status: PENDING
base_branch: dev
target_branch: feature/phase1-frontend-status-polling

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

Poll asynchronous job state after `phase1-frontend-direct-upload` has been merged into `dev`.

# Non-Goals

- Do not request playback or initialize video.js.
- Do not add retry policy, job cancellation, or statuses beyond the contract.
- Do not proxy API or media traffic.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, agent code, or GitHub Workflows.
- Do not run more than one polling loop or treat `FAILED` as success.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-frontend-direct-upload` is a prerequisite and must already be merged into `dev`.
- Status comes only from `GET /api/v1/videos/{videoId}`.
- Polling uses the API-returned video ID and stops on terminal state, error, or disposal.
- `FAILED` never advances to playback.

# Tasks

## frontend-status-polling: Poll and render asynchronous state

### Requirement

After direct upload success, poll the status endpoint at a bounded interval, render contract statuses, and stop deterministically on `COMPLETED`, `FAILED`, unrecoverable error, replacement, or component disposal.

### Acceptance Criteria

- All five contract statuses render without invented values.
- At most one polling loop exists for the active upload.
- Controlled timers verify progression and cleanup.
- `FAILED` renders contract failure details and never requests playback.
- In-flight responses from disposed or replaced workflows cannot mutate current state.

### Validation

```text
npm --prefix app/frontend run test:unit -- --run
```

# Final Verification

```text
npm --prefix app/frontend run test:unit -- --run
```
