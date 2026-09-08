---
schema_version: 1
id: phase2-reliability-e2e-runtime-config
title: Phase 2 Reliability E2E Runtime Configuration
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-runtime-config

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

Establish the gated, offline-discoverable reliability harness after the Phase 2 implementation, Phase 1 browser playback baseline, and human Phase 2 Terraform verification are available on `dev/phase2`.

# Non-Goals

- Do not implement failure scenarios, the Python runner, evidence collection, or operator runbooks.
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

- `phase2-reliability-contract`, `phase2-job-lease-persistence`, `phase2-infra-queue-monitoring`, `phase2-worker-queue-visibility`, `phase2-worker-lease-acquisition`, `phase2-worker-heartbeat-lifecycle`, `phase2-worker-retry-processing`, `phase2-worker-message-completion`, `phase1-e2e-browser-playback` are prerequisites and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- This file replaces the original monolithic validation scope with the first of eight work units: 40 runtime configuration -> 41 evidence and component matrix -> 42 preflight -> 43 duplicate delivery -> 44 crash/heartbeat -> 45 failure/DLQ -> 46 playback regression -> 47 runbooks and final verification.
- Each numbered successor requires its predecessor merged into `dev/phase2`; this serial merge order avoids concurrent edits to shared harness files. File numbering alone does not schedule cross-Spec dependencies.
- Cross-Spec prerequisites are recorded here, not in `depends_on`, which resolves only task IDs within one Spec. Each work unit contains one task with `depends_on: []`.
- Retain Phase 1 project selection and `@phase1-pipeline` behavior. Reliability execution requires its own explicit opt-in; discovery placeholders never authorize live execution.

# Tasks

## reliability-e2e-runtime-config: Reliability E2E Runtime Configuration

depends_on: []

### Requirement

Add a separate reliability Playwright project and typed configuration boundary, reusing the Phase 1 harness. Provide offline discovery, helper tests, and a package script that actually type-checks E2E files. Define bounded scenario timing and a dedicated disposable-environment opt-in without introducing any live failure test.

### Acceptance Criteria

- `test:e2e:helpers`, `test:e2e -- --list`, and the new `test:e2e:type-check` script work without AWS credentials, real endpoints, browser launch, or external service calls.
- The type-check script covers the Playwright configuration and all E2E TypeScript files; listing tests alone is not treated as type checking.
- Reliability scenarios are discoverable offline but never execute in an ordinary Phase 1 run. Direct project selection also enforces live gating.
- Live configuration requires explicit disposable opt-in, frontend/API endpoints, source/DLQ identifiers, bucket names, alarm identifiers, and documented worker/database observation and process-control inputs; validation errors redact secret values.
- Navigation, upload, processing, lease/visibility recovery, DLQ observation, and playback waits have finite validated bounds. Reliability scenarios run serially with automatic scenario retries disabled.
- Offline tests cover missing/invalid inputs, isolated project selection, and the distinction between discovery defaults and live authorization.

### Validation

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
```
