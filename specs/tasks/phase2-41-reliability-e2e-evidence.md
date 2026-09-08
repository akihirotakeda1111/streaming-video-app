---
schema_version: 1
id: phase2-reliability-e2e-evidence
title: Phase 2 Reliability E2E Evidence and Component Matrix
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-evidence

allowed_paths:
  - app/frontend/e2e/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/infra/**
  - app/backend/**
  - app/frontend/src/**
  - app/compose.yaml
  - app/docs/**
  - app/scripts/**

repair_attempt_limit: 5
review_attempt_limit: 3
---

# Objective

Create shared redacted evidence and run-scoped cleanup helpers, and assign every reliability failure to an executable validation owner.

# Non-Goals

- Do not add live failure injection, change backend tests, implement the runner, or claim planned live scenarios have already passed.
- Do not repair application, contracts, infrastructure, Compose, or production frontend code.
- Do not add CloudFront/OAC, ECS/Fargate, autoscaling, Step Functions, AWS Batch, ABR, distributed encoding, dashboards, or performance/load targets.
- Do not require external-failure execution in ordinary unit-test CI.

# Forbidden Actions

- Do not edit files outside `allowed_paths`, including Task Specs, agent code, and GitHub Workflows.
- Do not provision infrastructure, run Terraform, add production credentials, or target production/shared non-disposable resources.
- Do not log credentials, receipt handles, database URLs, full presigned URLs, or unredacted query strings.
- Do not purge queues, automatically replay the DLQ, or delete unrelated data. Cleanup is limited to resources and canonical IDs created by the current test run.
- If prerequisites are missing, the environment is not explicitly disposable, safe failure injection/observation is unavailable, or behavior conflicts with the reliability contract, stop and report evidence instead of changing implementation.

# Architecture Invariants

- `phase2-reliability-e2e-runtime-config` is a prerequisite and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- Internal lease/attempt fields are observed through existing database or worker boundaries; they are never added to public API responses.
- Reacquisition before durable completion may legitimately re-encode and overwrite deterministic object keys. Duplicate active deliveries and already-COMPLETED redeliveries must not repeat media work.

# Tasks

## reliability-e2e-evidence: Reliability E2E Evidence and Component Matrix

depends_on: []

### Requirement

Create shared run IDs, canonical resource tracking, bounded observation, secret-safe diagnostics, and cleanup helpers under the E2E tree. Check in a validation matrix there that maps every original failure to actual existing component tests or a named successor live scenario, including commands and required evidence.

### Acceptance Criteria

- Evidence records run/video/job IDs, worker ownership, attempts, state transitions, object keys, queue/alarm observations, and UTC timestamps; helpers support bounded polling and timeout evidence.
- Logs, errors, attachments, traces, and reports cannot expose credentials, receipt handles, database URLs, full presigned URLs, or unredacted query strings. Disable unsafe raw artifacts when reliable sanitization is unavailable.
- Cleanup only handles resources and canonical IDs registered by this run, including partial setup and failure paths. Queue purge, automatic replay, broad prefix deletion, and deletion of unrelated data are unavailable.
- The checked-in matrix maps duplicate delivery to Spec 43; crash and long heartbeat to 44; invalid media/FFmpeg, poison input, attempt exhaustion, DLQ isolation and alarm inspection to 45; and Phase 1 playback to 46.
- Download, partial segment upload, manifest upload, and database update failures map to actual deterministic tests from `phase2-worker-retry-processing`; post-completion delete failure maps to actual tests from `phase2-worker-message-completion`. Record exact test paths/names and commands after inspecting merged code, not invented selectors.
- Execute the component evidence to prove no false completion, no concurrent unauthorized processing, and no repeat encoding after durable COMPLETED. Allow contract-authorized retries before completion; distinguish failure before durable completion from acknowledgement failure after it.
- Missing component coverage blocks this work unit and is reported to the owning implementation Spec; do not substitute E2E mocks of an unverified backend or mutate IAM/network infrastructure.
- Live rows identify the owning successor Spec and are explicitly pending until implemented. Spec 46 must resolve them to real executable scenario selectors; pending rows cannot count as final coverage.
- Offline helper tests exercise redaction, bounded waits, resource ownership checks, and cleanup after partial failure using local fakes.

### Validation

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
cargo test --manifest-path app/backend/worker/Cargo.toml
```
