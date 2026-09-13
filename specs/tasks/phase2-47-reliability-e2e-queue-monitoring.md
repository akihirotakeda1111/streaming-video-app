---
schema_version: 1
id: phase2-reliability-e2e-queue-monitoring
title: Phase 2 Reliability E2E Queue and Alarm Observation
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-queue-monitoring

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

Verify Queue and Alarm Observation in the explicitly disposable environment.

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

- `phase2-reliability-e2e-dlq-isolation` is a prerequisite and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- SQS receive count and database attempt count are distinct; only lease acquisition increments attempt.
- The source queue redrive policy moves failed/poison messages to the DLQ; the worker does not send them there.
- Alarm state inspection records actual observations, including INSUFFICIENT_DATA; this scope does not require forcing every alarm to ALARM.

# Tasks

## reliability-e2e-queue-monitoring: Reliability E2E Queue and Alarm Observation

depends_on: []

### Requirement

Add independently selectable read-only queue/alarm inspection correlated with the FFmpeg exhaustion and poison-isolation evidence from Specs 45 and 46. Inspect source backlog/age and DLQ alarms without forcing transitions or altering infrastructure.

### Acceptance Criteria

- Register a dedicated queue-monitoring selector in the Python runner, selecting the reliability project and only its own scenario tag. Reuse common live preflight before any scenario operation and cover routing/authorization with offline fake-dispatch tests.
- Record source backlog/age, DLQ depth, alarm identifiers, actual states/reasons, and observation times with bounded eventual-consistency waits. Distinguish metric delay from proven isolation.
- Inspect source backlog/age alarms and DLQ alarms, including INSUFFICIENT_DATA. Correlate redacted run/evidence identities and timestamps with both failure scenarios without forcing ALARM or changing thresholds, IAM, or network configuration.
- Reuse actual run-owned DLQ isolation evidence from Specs 45 and 46; aggregate approximate counts alone cannot prove isolation. Standalone monitoring reports absent scenario evidence as outstanding rather than claiming scenario success.
- Monitoring uses read-only queue attributes, metrics, and alarm APIs; it does not receive, delete, replay, or inject messages. DLQ message receives remain owned by gated failure scenarios, including their visibility effects and receipt-handle redaction.
- Make monitoring available to Spec 48 after both failure scenarios and before final fresh upload. Bounded metric observation must not rerun or mutate the failure scenarios.
- Update the queue metrics and alarm inspection matrix entries with real selectors/live commands. Cover offline discovery/type checking/helper assertion tests; human verification retains actual live evidence.

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
