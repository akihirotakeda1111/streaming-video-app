---
schema_version: 1
id: phase2-reliability-e2e-runbooks
title: Phase 2 Reliability Operator Runbooks and Final Verification
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-runbooks

allowed_paths:
  - app/docs/runbooks/retry-and-idempotency.md
  - app/docs/runbooks/dlq-redrive.md

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
  - app/scripts/**

repair_attempt_limit: 1
review_attempt_limit: 3
---

# Objective

Complete the Phase 2 Reliability MVP documentation and final verification after every split reliability E2E work unit has merged into `dev/phase2`.

# Non-Goals

- Do not modify the harness or implementation, execute manual replay, provision infrastructure, or substitute runbook prose for executable evidence.
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

- `phase2-reliability-e2e-playback-regression` is a prerequisite and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- This is Spec 49, following Spec 48 playback regression, and the final work unit for the original Phase 2 reliability validation scope; all prior matrix owners must be implemented.
- Runbooks use actual merged runner flags, selectors, timing configuration and evidence paths rather than inventing interfaces.

# Tasks

## reliability-e2e-runbooks: Reliability Operator Runbooks and Final Verification

depends_on: []

### Requirement

Write concise retry/idempotency and DLQ redrive runbooks explaining symptoms, safe observation, bounded waiting, ownership, manual recovery prerequisites, cleanup, and escalation. Cross-link the checked-in executable validation matrix and document the final human verification sequence.

### Acceptance Criteria

- `retry-and-idempotency.md` explains duplicate active delivery, completed redelivery, crash recovery, heartbeat loss, transient download/upload/database failures, FFmpeg retries, attempt exhaustion, and post-completion delete failure.
- Document lease ownership checks using database time, visibility/lease/retry/redrive/metric waiting bounds from actual configuration, and the distinction between job attempts and queue receive counts.
- `dlq-redrive.md` documents read-only metric/alarm inspection and the visibility effects of message inspection; all examples use non-secret placeholders and redact query strings and receipt handles.
- Manual replay requires explicit human intent, exact disposable target and message/job identity, root-cause resolution, no active owner, and eligible state/attempt budget. COMPLETED must not be re-encoded; terminal FAILED or exhausted crashed jobs cannot be made retryable by replay alone.
- If safe replay requires a state/budget reset or unsupported recovery behavior, stop and escalate; do not invent database edits, automatic replay, bulk queue purge, or a repair mechanism outside the contract.
- Cleanup is limited to current-run canonical resources. Uncertain ownership, unavailable safe controls, contract conflict, unexpected terminal state, or exceeded waiting bounds require retained redacted evidence and human escalation.
- Both runbooks provide actual offline check and live commands, environment prerequisites, evidence locations, and the final Phase 1 playback verification. Human Terraform verification and successful full live evidence are required for MVP sign-off; offline success alone is insufficient.
- Cross-check every documented command and matrix link against the merged harness, execute Final Verification, and retain the human live run result or clearly report it outstanding.

### Validation

```text
python app/scripts/validate_contracts.py
```

# Final Verification

```text
python app/scripts/validate_contracts.py
```
