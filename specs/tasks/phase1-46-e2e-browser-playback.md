---
schema_version: 1
id: phase1-e2e-browser-playback
title: Phase 1 E2E Browser Playback
status: PENDING
base_branch: dev
target_branch: feature/phase1-e2e-browser-playback

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

repair_attempt_limit: 5
review_attempt_limit: 3
---

# Objective

Complete Phase 1 by proving video.js playback advances after `phase1-e2e-hls-objects` has been merged into `dev`.

# Non-Goals

- Do not repair application or infrastructure code or validate Phase 2 features.
- Do not provision infrastructure or run Terraform/AWS mutation commands.
- Do not treat API completion or object existence alone as playback success.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, application code, infrastructure, agent code, or GitHub Workflows.
- Do not declare success without positive media-time advancement in a real browser.
- If behavior conflicts with a contract, report it instead of editing the application.

# Architecture Invariants

- `phase1-e2e-hls-objects` is a prerequisite and must already be merged into `dev`.
- Exactly one video.js player uses the API manifest URL.
- Readiness and positive `currentTime` advancement occur in a real browser.
- Fatal player, manifest, segment, network, or CORS errors fail the scenario.
- Terraform verification remains a separate human pre-merge activity and is not run here.

# Tasks

## e2e-browser-playback: Prove media playback advances

### Requirement

Continue the same pipeline scenario through player initialization, media readiness, playback start, and measurable `currentTime` advancement while collecting redacted evidence.

### Acceptance Criteria

- Exactly one player initializes with the playback API manifest URL.
- The player reaches a usable ready state.
- `currentTime` advances by a positive measurable amount within the timeout.
- No fatal player, manifest, segment, network, or CORS error occurs.
- Report includes non-secret IDs, terminal status, manifest origin, segment count, and advancement.

### Validation

```text
npm --prefix app/frontend run test:e2e -- --grep @phase1-pipeline
```

# Final Verification

```text
python app/scripts/validate_contracts.py
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml
npm --prefix app/frontend run test:unit -- --run
npm --prefix app/frontend run type-check
npm --prefix app/frontend run lint
npm --prefix app/frontend run build
npm --prefix app/frontend run test:e2e -- --grep @preflight
npm --prefix app/frontend run test:e2e -- --grep @phase1-pipeline
```
