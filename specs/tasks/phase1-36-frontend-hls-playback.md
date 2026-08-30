---
schema_version: 1
id: phase1-frontend-hls-playback
title: Phase 1 Frontend HLS Playback
status: PENDING
base_branch: dev
target_branch: feature/phase1-frontend-hls-playback

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

Load completed direct-S3 HLS output through video.js after `phase1-frontend-status-polling` has been merged into `dev`.

# Non-Goals

- Do not proxy or rewrite HLS, construct segments, or add CloudFront/signing behavior.
- Do not request playback before completion.
- Do not add adaptive-bitrate authoring, analytics, or retry controls.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, backend, agent code, or GitHub Workflows.
- Do not silently treat player, manifest, segment, or CORS errors as success.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-frontend-status-polling` is a prerequisite and must already be merged into `dev`.
- Playback is requested once after `COMPLETED`.
- video.js receives the API-returned direct-S3 manifest URL and contract content type.
- Replacing a video or unmounting disposes the current player.

# Tasks

## frontend-hls-playback: Request playback and manage video.js

### Requirement

Request the playback resource after completion, initialize exactly one video.js player with the returned HLS source, expose controls and errors, and dispose it on replacement or unmount.

### Acceptance Criteria

- Playback request occurs only after `COMPLETED`.
- `manifestUrl` is passed unchanged with `application/vnd.apple.mpegurl`.
- Manifest and relative segments load directly from S3 without proxy/rewrite logic.
- Player and media errors are visible.
- Tests cover request timing, initialization, replacement, cleanup, and errors.

### Validation

```text
npm --prefix app/frontend run test:unit -- --run
```

# Final Verification

```text
npm --prefix app/frontend run test:unit -- --run
```
