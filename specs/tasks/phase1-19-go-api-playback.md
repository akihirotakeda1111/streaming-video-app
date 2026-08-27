---
schema_version: 1
id: phase1-go-api-playback
title: Phase 1 Go API Completed-Only Playback
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-playback

allowed_paths:
  - app/backend/api/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/infra/**
  - app/backend/worker/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Complete the Phase 1 Go API with direct-S3 HLS playback resolution after `phase1-go-api-video-status` has been merged into `dev`.

# Non-Goals

- Do not add CloudFront, signed cookies, manifest rewriting, or manifest-only presigned URLs.
- Do not upload bytes, run FFmpeg, publish SQS messages, or add endpoints beyond the contract and health check.
- Do not create, rewrite, or extend shared contracts or examples.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not expose a playback URL for an incomplete or failed job.
- Do not hard-code bucket names or public endpoints.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-video-status` is a prerequisite and must already be merged into `dev`.
- `GET /api/v1/videos/{videoId}/playback` returns `409` until the job is `COMPLETED`.
- Completed playback uses the canonical direct-S3 `index.m3u8` URL and HLS content type.
- Output bucket and endpoint values are configuration-driven and have no CloudFront dependency.

# Tasks

## playback: Implement completed-only playback resolution

### Requirement

Implement the playback endpoint and construct the canonical direct-S3 manifest URL only when the stored job is `COMPLETED`.

### Acceptance Criteria

- A completed job returns `200`, protocol `HLS`, `application/vnd.apple.mpegurl`, and the canonical manifest URL.
- `UPLOADING`, `QUEUED`, and `PROCESSING` return the documented `409` response.
- `FAILED` exposes no manifest URL and returns the documented non-playable response.
- Unknown videos return `404`.
- Tests cover URL escaping, canonical keys, and every status branch.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
python app/scripts/validate_contracts.py
go test -C app/backend/api ./...
```
