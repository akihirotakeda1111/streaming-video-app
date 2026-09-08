---
schema_version: 1
id: phase2-reliability-e2e-preflight
title: Phase 2 Reliability E2E Safe Preflight and Runner
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-e2e-preflight

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

Provide one safe runner and documented environment checks before any live reliability scenario can start.

# Non-Goals

- Do not implement duplicate, recovery, failure, or playback assertions; do not provision or repair the environment.
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

- `phase2-reliability-e2e-evidence` is a prerequisite and must already be merged into `dev/phase2` (or included through a merged ancestor). A merge to `dev` alone is insufficient unless present in this base branch.
- The Phase 2 implementation prerequisites and Phase 1 browser playback baseline from Spec 40 remain required transitively. Phase 2 Terraform must be human-verified before live verification.
- `app/contracts/domain/reliability-conventions.md` is authoritative; Phase 1 upload, manifest-last publication, API completion, HLS checks, and browser playback remain the regression baseline.
- Live scenarios require explicit disposable opt-in, unique run IDs, validated resource identities, bounded waits, redacted evidence, and run-scoped cleanup. Controls use documented worker/process/service boundaries only.
- Automated Validation and Final Verification commands below do not execute live failure scenarios. Human pre-merge verification owns the configured live run; missing live evidence must be reported as outstanding.
- The Python runner and direct Playwright entry points enforce the same live safety conditions.
- `--check` is an offline validation mode, not proof that live resources exist or that live verification passed.

# Tasks

## reliability-e2e-preflight: Reliability E2E Safe Preflight and Runner

depends_on: []

### Requirement

Implement `run_reliability_e2e.py` with a side-effect-free `--check` mode and an explicitly gated live mode. Document its configuration, scenario selection, evidence locations, and process/service control boundaries within the E2E tree. Reuse the typed configuration and evidence helpers; add fake-boundary tests through the existing helper test command.

### Acceptance Criteria

- `--check` checks required local tools and parses provided configuration without AWS credentials, contacting external services, starting/stopping containers, executing scenarios, or changing queues, objects, or database state.
- With required local tools present, absent live configuration is reported as not configured and is not an offline-check failure; malformed supplied settings or missing tools fail with redacted diagnostics. The live path always rejects incomplete configuration.
- Live preflight verifies disposable opt-in and non-secret resource identities, source-to-DLQ relationship, timing/attempt settings, alarm targets, and configured worker/database observation and process-control capabilities before any mutation.
- Checks use bounded read-only observations and never print credential values. A configured flag alone does not replace target identity validation.
- The runner supports selecting implemented scenarios and lists available selectors. An unknown/unimplemented selector fails; the final full sequence is assembled by Spec 46.
- Worker termination/restart controls are limited to an explicitly identified disposable worker process/service, exclude unrelated processes, and restore the prior test-owned runtime state after failure when safe.
- Unsupported injection/observation boundaries stop with evidence before injection. The runner does not edit source, Compose, IAM, network, or Terraform to make a scenario possible.
- Offline tests prove both runner and direct Playwright execution reject missing opt-in/identifiers and that `--check` does not invoke live adapters or mutation commands.

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
