---
schema_version: 1
id: phase2-reliability-e2e-duplicate-delivery
title: Phase 2 Reliability E2E Duplicate Delivery
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-duplicate-delivery

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

Prove live duplicate delivery is idempotent during active ownership and after durable completion.

# Non-Goals

- Do not add crash/restart, heartbeat-duration, FFmpeg exhaustion, or DLQ scenarios.
- Do not implement missing common live-preflight adapters here; completing them is owned by Spec 42.
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

- `phase2-reliability-e2e-preflight` is a prerequisite and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- The prerequisite includes Spec 42's working read-only live verification adapters and retained human preflight success evidence for the intended environment. A prior merge containing only configuration validation and unconditional live rejection is insufficient; stop and report that incomplete prerequisite before implementing this scenario.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- Duplicate messages retain the standard S3 event shape and target only a canonical job/source created by this test run.
- Final state or deterministic object names alone cannot prove one effective encode; use worker/process evidence.

# Tasks

## reliability-e2e-duplicate-delivery: Reliability E2E Duplicate Delivery

depends_on: []

### Requirement

Implement an individually selectable, gated duplicate-delivery scenario using documented queue/service boundaries. Register its dedicated selector in `run_reliability_e2e.py`, route it to the reliability project and an exact scenario tag, and document the command in the E2E runner guide and matrix. Reuse Spec 42's common live authorization before any scenario operation. Observe the same canonical job while its lease is active and again after completion, correlating database and worker evidence.

### Acceptance Criteria

- The runner lists and accepts the dedicated duplicate-delivery selector and dispatches only that scenario in the reliability project. Do not use the broad `@reliability` tag as the scenario selector; existing selectors remain compatible and unknown selectors still fail.
- Offline fake-dispatch tests cover selector registration, exact tag/project selection, and refusal to dispatch when live authorization fails. Direct Playwright selection also performs common live authorization before injection.
- A valid run-owned upload reaches active processing; injected duplicate delivery during the active lease causes no second download, encode, publication, or attempt increment.
- The job reaches one durable COMPLETED result with manifest-last publication and one effective encode/publication for this successful, non-crashing scenario.
- Redelivery after durable COMPLETED only acknowledges: no download, FFmpeg, upload, lease/state overwrite, or attempt increment.
- Assertions use correlated attempts, worker ownership, side-effect evidence, and timestamps; insufficient observation or inability to exercise busy delivery is reported as unverified, never passed.
- The matrix row now names the real scenario selector and live command. Offline discovery, type checking, and helper tests do not execute the live scenario.
- Human pre-merge verification runs the documented selector through the gated runner and retains redacted evidence; timeout/failure cleans up only run-owned resources.

### Validation

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
python app/scripts/run_reliability_e2e.py --check
```

# Final Verification

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e -- --list
npm --prefix app/frontend run test:e2e:type-check
python app/scripts/run_reliability_e2e.py --check
```
