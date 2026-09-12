---
schema_version: 1
id: phase2-reliability-e2e-playback-regression
title: Phase 2 Reliability E2E Final Playback Regression
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-playback-regression

allowed_paths:
  - app/frontend/e2e/**
  - app/scripts/run_reliability_e2e.py

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
  - app/scripts/validate_contracts.py
  - app/scripts/validate_terraform_contracts.py

repair_attempt_limit: 5
review_attempt_limit: 3
---

# Objective

Assemble the complete reliability run with the unchanged Phase 1 browser playback path as its final scenario and close the executable coverage matrix.

# Non-Goals

- Do not weaken the Phase 1 assertions, change application code, write operator recovery procedures, or declare the release verified from offline checks alone.
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

- `phase2-reliability-e2e-queue-monitoring` is a prerequisite and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- Phase 1 browser playback implementation is already available on the base branch and is reused.
- Failure scenarios must restore the worker/service boundary before the final fresh upload; inability to restore blocks the regression run.

# Tasks

## reliability-e2e-playback-regression: Reliability E2E Final Playback Regression

depends_on: []

### Requirement

Complete the runner's serial full-suite selection and finish with a fresh Phase 1 direct upload through processing, HLS validation and real-browser playback. Resolve every matrix row to an executable component command or implemented gated live selector.

### Acceptance Criteria

- The full run executes duplicate delivery, crash recovery, long heartbeat, FFmpeg exhaustion (Spec 45), poison isolation (Spec 46), and queue/alarm inspection (Spec 47) before the final fresh upload. A failure or missing scenario produces a non-success result, never a partial-pass summary.
- The final scenario covers direct upload, processing, durable API COMPLETED, segment-before-manifest publication evidence, HLS object checks, and positive measurable browser media-time advancement.
- Reuse the `@phase1-pipeline` path and its player/network/CORS failure assertions; neither API completion nor object existence alone counts as playback success.
- All matrix rows have real test names/paths, executable commands or live selectors, expected assertions, and evidence locations. There are no placeholder, skipped-as-passed, or unowned failures.
- The combined report separates component checks, actual live evidence, and unexecuted live checks, with run/video/job IDs and redacted observations.
- Human pre-merge verification executes the full gated live command with the configured disposable environment; ordinary automated validation remains offline/static/component-only.

### Validation

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
python app/scripts/run_reliability_e2e.py --check
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage reliability
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
python app/scripts/run_reliability_e2e.py --check
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage reliability
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml
```
