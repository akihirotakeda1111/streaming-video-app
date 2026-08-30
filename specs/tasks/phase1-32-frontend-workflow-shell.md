---
schema_version: 1
id: phase1-frontend-workflow-shell
title: Phase 1 Frontend Upload Workflow Shell
status: PENDING
base_branch: dev
target_branch: feature/phase1-frontend-workflow-shell

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

Create the Phase 1 upload-and-playback view state shell after `phase1-frontend-contract-client` has been merged into `dev`.

# Non-Goals

- Do not call the API, upload to S3, start polling, or initialize video.js.
- Do not add authentication, retries, multipart upload, analytics, or a video library.
- Do not modify contracts or backend behavior.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, agent code, or GitHub Workflows.
- Do not accept non-MP4 input or invent backend statuses.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-frontend-contract-client` is a prerequisite and must already be merged into `dev`.
- UI workflow states are explicit and separate from contract job statuses.
- Only `video/mp4` is selectable for Phase 1.
- Component disposal provides hooks for later request, timer, and player cleanup.

# Tasks

## frontend-workflow-shell: Implement file selection and visible states

### Requirement

Implement one accessible upload-and-playback view with MP4 selection, submit controls, status/error presentation, and explicit idle, creating, uploading, processing, ready, and error workflow states.

### Acceptance Criteria

- Only one `video/mp4` file can enter the workflow.
- Invalid type or empty selection shows an actionable error without network activity.
- Controls prevent duplicate submissions while active.
- Visible state changes are testable through injected workflow actions.
- Component teardown exposes deterministic cleanup behavior.

### Validation

```text
npm --prefix app/frontend run test:unit -- --run
```

# Final Verification

```text
npm --prefix app/frontend run test:unit -- --run
```
