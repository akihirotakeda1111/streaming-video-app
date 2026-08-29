---
schema_version: 1
id: phase1-e2e-hls-objects
title: Phase 1 E2E HLS Objects and CORS
status: PENDING
base_branch: dev
target_branch: feature/phase1-e2e-hls-objects

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

Validate canonical direct-S3 HLS publication and browser CORS after `phase1-e2e-pipeline-completion` has been merged into `dev`.

# Non-Goals

- Do not declare media playback success.
- Do not add CloudFront, rewrite manifests, sign only the manifest, or repair output objects.
- Do not modify system implementation.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, application code, infrastructure, agent code, or GitHub Workflows.
- Do not accept missing segments, foreign URLs, path traversal, or wrong content types.
- If behavior conflicts with a contract, report it instead of editing the application.

# Architecture Invariants

- `phase1-e2e-pipeline-completion` is a prerequisite and must already be merged into `dev`.
- Playback API returns the canonical direct-S3 manifest only after completion.
- The browser fetches manifest and relative segments from the S3 output origin.
- No CloudFront or manifest-only signing workaround is accepted.

# Tasks

## e2e-hls-objects: Validate manifest, segments, and CORS

### Requirement

Obtain the playback response, fetch the manifest in browser context, parse relative segment references, and verify canonical keys, content types, object availability, and browser CORS behavior.

### Acceptance Criteria

- Playback response identifies HLS and the canonical direct-S3 `index.m3u8` URL.
- Manifest succeeds from the frontend origin with at least one relative `segment-{nnnnn}.ts` reference.
- Every referenced segment succeeds under the same canonical prefix.
- Manifest and segment content types match the contracts.
- CloudFront, foreign/absolute segments, traversal, and missing segments fail.

### Validation

```text
npm --prefix app/frontend run test:e2e -- --grep @phase1-pipeline
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e -- --grep @phase1-pipeline
```
