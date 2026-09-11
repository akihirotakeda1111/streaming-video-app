---
schema_version: 1
id: phase2-reliability-e2e-attempt-exhaustion
title: Phase 2 Reliability E2E FFmpeg Attempt Exhaustion
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-attempt-exhaustion

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

Verify FFmpeg Attempt Exhaustion in the explicitly disposable environment.

# Non-Goals

- Do not replay the DLQ, force alarm transitions, alter thresholds or IAM/network configuration, or add load testing.
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

- `phase2-reliability-e2e-worker-recovery` is a prerequisite and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- SQS receive count and database attempt count are distinct; only lease acquisition increments attempt.
- The source queue redrive policy moves failed/poison messages to the DLQ; the worker does not send them there.
- Alarm state inspection records actual observations, including INSUFFICIENT_DATA; this scope does not require forcing every alarm to ALARM.

# Tasks

## reliability-e2e-attempt-exhaustion: Reliability E2E FFmpeg Attempt Exhaustion

depends_on: []

### Requirement

Add an independently selectable invalid-media/FFmpeg exhaustion scenario proving bounded acquisition attempts, durable terminal failure, absence of manifest-backed playback, and actual run-owned message isolation by source-queue redrive.

### Acceptance Criteria

- Register a dedicated FFmpeg-exhaustion selector in the Python runner, selecting the reliability project and only its own scenario tag. Reuse common live preflight before any scenario operation and cover routing/authorization with offline fake-dispatch tests.
- Invalid media at a canonical source reaches real FFmpeg processing failure, retries within the configured acquisition budget, and ends in durable FAILED with non-empty failure details on an exhausted owned failure.
- The failed job never exposes manifest-backed playback and is eventually isolated by source-queue redrive without further encoding or attempt increments after terminal failure.
- DLQ evidence correlates the actual run-owned message/body or canonical IDs with bounded observations; aggregate approximate counts alone are insufficient.
- Document that receiving DLQ messages temporarily changes visibility, use it only inside the gated disposable run, never auto-replay, and do not delete unrelated messages. Receipt handles never enter artifacts.
- Provide reusable bounded, redacted run-owned DLQ correlation helpers for Spec 46. Queue metrics and alarm inspection belong to Spec 47 and cannot replace message-level isolation evidence.
- Update the FFmpeg failure, attempt exhaustion, and failed-job DLQ isolation matrix entries with real selectors/live commands. Cover offline discovery/type checking/helper assertion tests; human verification retains actual live evidence.

### Validation

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
python app/scripts/run_reliability_e2e.py --check
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage reliability
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
python app/scripts/run_reliability_e2e.py --check
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage reliability
```
