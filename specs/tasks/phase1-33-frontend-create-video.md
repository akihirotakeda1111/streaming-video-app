---
schema_version: 1
id: phase1-frontend-create-video
title: Phase 1 Frontend Video Creation
status: PENDING
base_branch: dev
target_branch: feature/phase1-frontend-create-video

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

Implement browser-driven video/job creation after `phase1-frontend-workflow-shell` has been merged into `dev`.

# Non-Goals

- Do not send source bytes, perform direct S3 upload, poll status, or initialize playback.
- Do not derive object keys or sign URLs in the browser.
- Do not add retries, authentication, or multipart upload.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, agent code, or GitHub Workflows.
- Do not expose AWS credentials or silently ignore API errors.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-frontend-workflow-shell` is a prerequisite and must already be merged into `dev`.
- The create request sends file name as metadata, `video/mp4`, and exact browser file size.
- Returned video ID, job ID, method, URL, and required headers are retained unchanged.
- No source bytes are sent during job creation.

# Tasks

## frontend-create-video: Connect the form to job creation

### Requirement

Wire valid file submission to `POST /api/v1/videos`, retain the returned identifiers and upload instructions, and render success or actionable API error state without beginning upload.

### Acceptance Criteria

- Request metadata matches the selected browser file.
- Exactly one create request is active per submission.
- Returned upload instructions are stored without client-side key construction.
- Create failures do not attempt S3 upload or polling.
- Tests verify request fields, duplicate-submit prevention, response retention, and errors.

### Validation

```text
npm --prefix app/frontend run test:unit -- --run
```

# Final Verification

```text
npm --prefix app/frontend run test:unit -- --run
```
