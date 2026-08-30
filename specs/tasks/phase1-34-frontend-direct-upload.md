---
schema_version: 1
id: phase1-frontend-direct-upload
title: Phase 1 Frontend Direct S3 Upload
status: PENDING
base_branch: dev
target_branch: feature/phase1-frontend-direct-upload

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

Upload selected video bytes directly to the API-provided S3 URL after `phase1-frontend-create-video` has been merged into `dev`.

# Non-Goals

- Do not start status polling or playback.
- Do not proxy bytes through Vue, Vite, or Go API.
- Do not add retries, resumable/multipart upload, client-side signing, or key construction.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, agent code, or GitHub Workflows.
- Do not alter the API-provided method or required headers.
- Do not treat failed upload as success.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-frontend-create-video` is a prerequisite and must already be merged into `dev`.
- Video bytes go directly to the returned presigned URL.
- Method and required headers are used exactly as returned.
- Polling cannot begin until direct upload succeeds.

# Tasks

## frontend-direct-upload: Send bytes directly to S3

### Requirement

Implement an injectable upload boundary and wire the selected file to the returned presigned request, preserving destination, method, and headers exactly.

### Acceptance Criteria

- Upload destination, method, and headers come only from the API response.
- File bytes never target the API or Vite origin.
- Upload success advances to processing-ready state but does not itself start a player.
- Upload failure shows an actionable error and blocks polling/playback.
- Tests verify exact request behavior and failure handling with no live S3 access.

### Validation

```text
npm --prefix app/frontend run test:unit -- --run
```

# Final Verification

```text
npm --prefix app/frontend run test:unit -- --run
```
