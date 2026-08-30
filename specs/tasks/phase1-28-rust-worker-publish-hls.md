---
schema_version: 1
id: phase1-rust-worker-publish-hls
title: Phase 1 Rust Worker HLS Publication
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-publish-hls

allowed_paths:
  - app/backend/worker/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/infra/**
  - app/backend/api/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Publish validated HLS objects in the required S3 order after `phase1-rust-worker-encode-hls` has been merged into `dev`.

# Non-Goals

- Do not write `COMPLETED` or `FAILED`, delete SQS messages, or implement retry/recovery policy.
- Do not create multiple renditions, random prefixes, CloudFront behavior, or manifest rewriting.
- Do not upload unreferenced or unvalidated files.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not upload `index.m3u8` before every referenced segment succeeds.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-encode-hls` is a prerequisite and must already be merged into `dev`.
- Output keys use `videos/{video_id}/jobs/{job_id}/hls/`.
- Referenced segments upload before `index.m3u8`.
- Segments use `video/mp2t`; the manifest uses `application/vnd.apple.mpegurl`.

# Tasks

## publish-hls: Upload segments and manifest in canonical order

### Requirement

Upload every validated referenced segment to the canonical output prefix and upload `index.m3u8` only after all segment writes succeed.

### Acceptance Criteria

- Keys exactly match the storage contract.
- Only playlist-referenced segments are published for the job.
- Every segment succeeds before manifest upload begins.
- Content types match the contract.
- Any segment failure prevents manifest upload.
- Tests assert keys, content types, and complete segments-before-manifest ordering.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
