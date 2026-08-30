---
schema_version: 1
id: phase1-rust-worker-encode-hls
title: Phase 1 Rust Worker HLS Encoding
status: PENDING
base_branch: dev
target_branch: feature/phase1-rust-worker-encode-hls

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

Encode and validate one canonical HLS rendition after `phase1-rust-worker-processing-download` has been merged into `dev`.

# Non-Goals

- Do not upload output, write terminal state, or delete SQS messages.
- Do not use FFmpeg FFI, shell interpolation, or multiple renditions.
- Do not add retry, lease, heartbeat, DLQ, or recovery behavior.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, agent code, or GitHub Workflows.
- Do not accept missing or unsafe playlist output.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-rust-worker-processing-download` is a prerequisite and must already be merged into `dev`.
- FFmpeg receives an argv list and produces one media playlist.
- Segments are zero-based, five-digit `segment-{nnnnn}.ts` files.
- Playlist references are relative and stay inside the work directory.

# Tasks

## encode-hls: Invoke FFmpeg and validate its output

### Requirement

Invoke FFmpeg CLI using a fixed argument structure to produce `index.m3u8` and `segment-%05d.ts`, then validate the playlist and referenced local files before publication is allowed.

### Acceptance Criteria

- FFmpeg arguments use an argv list without shell interpolation.
- The expected playlist and at least one segment exist after success.
- Every media reference is relative, canonical, present, and contained in the work directory.
- Absolute URLs, path traversal, missing segments, and empty playlists are rejected.
- Tests inspect argv and valid/invalid output layouts through a fake process runner.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
