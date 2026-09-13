---
schema_version: 1
id: phase2-reliability-e2e-worker-recovery
title: Phase 2 Reliability E2E Crash Recovery and Heartbeats
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-worker-recovery

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

Verify crash recovery and long-running lease/visibility renewal through the same controlled worker lifecycle boundary.

# Non-Goals

- Do not change worker timing semantics, introduce production fault hooks, or require a final-attempt crash to write FAILED.
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

- `phase2-reliability-e2e-duplicate-delivery` is a prerequisite and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- `phase2-worker-heartbeat-observation` (Spec 26) must also be merged into `dev/phase2` before implementation. Reuse its `heartbeat_observation_schema=1` lease/visibility events and Spec 25's delivery correlation; do not add backend logging from this E2E task. Local observation timestamps are bounds, not authoritative database/SQS expiry; combine them with database time and explicit clock-skew handling.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- Database time decides lease expiry; SQS visibility and database lease are independent gates.
- Crash recovery uses an attempt with budget remaining. A crash on the final attempt cannot authorize a non-owner to fabricate FAILED or exceed the budget.

# Tasks

## reliability-e2e-worker-recovery: Reliability E2E Crash Recovery and Heartbeats

depends_on: []

### Requirement

Add two independently selectable gated scenarios sharing lifecycle observation helpers: terminate/restart a worker during an acquired processing attempt, and run an encode long enough to observe multiple heartbeat cycles.

### Acceptance Criteria

- Register dedicated crash-recovery and long-heartbeat selectors in the Python runner, each selecting the reliability project and only its own scenario tag. Reuse common live preflight before any scenario operation and cover routing/authorization with offline fake-dispatch tests.
- Crash injection occurs after acquisition and before durable completion with attempt budget remaining. The interrupted attempt cannot report false COMPLETED.
- Using the original message's redelivery, recovery occurs only after its visibility window and the old database lease expire. Correlate last renewal/extension and acquisition evidence instead of relying on a fixed sleep.
- Exactly one replacement owner reacquires and increments the attempt once; processing restarts from the canonical source and completes with deterministic keys and manifest-last publication.
- The long encode spans multiple heartbeat intervals, proves repeated successful visibility extensions and lease renewals, and prevents overlapping ownership without incrementing attempt during renewals.
- Controlled workload/process boundaries exercise the actual worker; skipped or too-short workloads cannot be recorded as heartbeat success.
- Both scenarios have finite configuration-derived deadlines, correlated redacted evidence, scoped cleanup and restoration, real selectors in the matrix, and documented human live commands.
- Offline helper tests cover expiry-bound calculations and evidence assertions; discovery/check/type checking never terminate a worker or run an encode against live services.

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
