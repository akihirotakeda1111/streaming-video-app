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

Complete the existing safe runner with working read-only live preflight adapters before Spec 43 begins. Preserve the offline checks and fail-closed behavior for unsupported environments, but provide a verified success path for the documented disposable environment.

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
- The previously merged configuration validator and unconditional `assertLiveBoundary()` rejection are an incomplete foundation, not completion of this Spec. This work unit owns the missing common live verification adapters; do not defer them to duplicate delivery or other successor scenarios.
- Spec 43 may begin only after this functional completion is merged into `dev/phase2` and a human has retained successful read-only preflight evidence for the intended disposable environment. Prior merge history and passing offline tests alone do not satisfy that prerequisite.

# Tasks

## reliability-e2e-preflight: Reliability E2E Safe Preflight and Runner

depends_on: []

### Requirement

Extend the existing `run_reliability_e2e.py` and shared E2E authorization boundary with bounded, read-only adapters for the documented disposable environment. Replace the unconditional live rejection with actual resource and capability verification, keeping rejection for unavailable or unsafe targets. Add an independently selectable live-preflight command that returns after verification without dispatching a failure or playback scenario. Document actual configuration, commands, required tools and existing permissions, evidence locations, and process/service control boundaries within the E2E tree. Reuse the typed configuration and evidence helpers; add fake-boundary tests through the existing helper test command.

### Acceptance Criteria

- `--check` checks required local tools and parses provided configuration without AWS credentials, contacting external services, starting/stopping containers, executing scenarios, or changing queues, objects, or database state.
- With required local tools present, absent live configuration is reported as not configured and is not an offline-check failure; malformed supplied settings or missing tools fail with redacted diagnostics. The live path always rejects incomplete configuration.
- Live preflight verifies disposable opt-in and non-secret resource identities, source-to-DLQ relationship, timing/attempt settings, alarm targets, and configured worker/database observation and process-control capabilities before any mutation.
- Checks use bounded read-only observations and never print credential values. A configured flag alone does not replace target identity validation.
- Verify actual account/region and configured bucket, source queue, DLQ, and alarm identities through supported service boundaries. Read the source queue redrive policy and compare its target with the actual DLQ identity; `E2E_SOURCE_DLQ_RELATIONSHIP=verified` is only a declaration and cannot authorize execution.
- Inspect actual worker/database identities and the availability of the observation/control boundaries. Compare effective worker and queue settings with the contract timing and attempt constraints. Never infer capability or ownership solely from an environment variable, process name, or opaque identifier.
- The standalone live-preflight command performs no job creation, queue send/receive/delete, media upload, database update, worker termination/restart, or failure injection. It may write only local redacted evidence; success records observed identities, capability results, and timestamps.
- Both the Python runner and each directly selected Playwright reliability scenario await the same verification result before any scenario operation. A separate authorization test does not establish ordering or permission for another test.
- Offline tests exercise successful verification with fake adapters, resource mismatches, unavailable/unsupported adapters, permission errors, timeouts, and redaction. Assert that failed verification prevents scenario dispatch and mutation; replace tests that require unconditional rejection for every complete configuration.
- The runner supports selecting implemented scenarios and lists available selectors. An unknown/unimplemented selector fails; the final full sequence is assembled by Spec 46.
- Worker termination/restart controls are limited to an explicitly identified disposable worker process/service, exclude unrelated processes, and restore the prior test-owned runtime state after failure when safe.
- Unsupported injection/observation boundaries stop with evidence before injection. The runner does not edit source, Compose, IAM, network, or Terraform to make a scenario possible.
- Implement at least one documented supported adapter path rather than an always-failing placeholder. Missing deployment permissions or unsupported observation/control capabilities are reported as blockers; do not mark this Spec complete or move that work into Spec 43.
- Offline tests prove both runner and direct Playwright execution reject missing opt-in/identifiers and that `--check` does not invoke live adapters or mutation commands.
- Update `app/frontend/e2e/reliability/runner.md` with the actual successful live-preflight command and supported adapter requirements. Human pre-merge verification must run that command against the intended disposable environment and retain its redacted success evidence. If unavailable, explicitly leave live acceptance outstanding.

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
