---
schema_version: 1
id: phase3-scalability-e2e-validation
title: Phase 3 Scalability E2E Integration Validation
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-scalability-e2e-validation

allowed_paths:
  - app/frontend/e2e/**
  - app/frontend/playwright.config.ts
  - app/scripts/run_scalability_e2e.py
  - app/docs/runbooks/scalability-e2e.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/scripts/run_reliability_e2e.py
  - app/scripts/generate_reliability_env.mjs
  - app/scripts/setup_reliability_env.mjs
  - app/infra/terraform-e2e/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Implement one bounded distributed Scalability E2E run against Task 89's distributed-enabled AWS environment, covering parent scale-out, concurrent jobs, concurrent child execution, ABR playback through CloudFront, completion of all jobs, and scale-in without extending Reliability E2E.

**Priority:** P1. This Markdown contains exactly one Task.

# Non-Goals

- **Out of Scope:** Extending, porting, or replacing Reliability E2E; duplicating its failure scenarios; new fault-injection infrastructure; forced crashes, duplicate delivery injection, retry/DLQ matrices, or FFmpeg/S3/database failure injection.
- Do not reimplement Tasks 01-24, add a separate application platform, tune new scaling algorithms, or implement FFmpeg FFI. Do not add test code under app/scripts.

# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validator and component tests. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.
- If application, contract, or infrastructure defects block validation, report evidence and stop. Do not expand this task to repair implementation; route fixes to the owning implementation task.
- Preserve the existing Reliability E2E scripts, scenarios, helper behavior, selectors, and environment. Broad allowed paths do not authorize changing them. Shared configuration changes must leave existing projects and commands unchanged.

# Architecture Invariants

**Preconditions / Dependencies:** `phase3-scalability-e2e-environment` (`phase3-89-scalability-e2e-environment.md`) must be merged into `main` or included through a merged ancestor. Cross-file dependencies are merged-base prerequisites; `depends_on` only describes tasks within this Markdown.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.

# Tasks

## scalability-e2e-validation: Phase 3 Scalability E2E Integration Validation

depends_on: []

### Requirement

**Scope / Allowed Changes:** Add run_scalability_e2e.py as an execution/configuration entrypoint, with offline --check and explicitly opted-in live --full. Put scenario assertions and helper tests under app/frontend/e2e, using a dedicated scalability Playwright project/tag. Reuse existing non-mutating helpers and Task 04/24 playback assertions where compatible without changing their behavior. Preserve existing project selection and discovery behavior; ordinary and Reliability E2E runs must not select scalability scenarios. Do not invoke or adapt the Reliability E2E runner, port Docker lifecycle controls to ECS, or change its scenarios. No Terraform or application changes belong here.

**Environment contract:** Consume Task 89's documented outputs/configuration and verify account, region, dedicated resource identities, API/frontend reachability, image versions, fixture availability, scaling limits, and configured job/runtime budget before live work. --check validates configuration offline without AWS calls; live preflight verifies that the actual Task 24-complete deployment is in distributed mode and the parent service is ready at its configured minimum of one. A non-distributed deployment must fail preflight; do not change its mode or service settings. Missing values or insufficient observation permissions are failures, not reasons to provision resources. Use Task 89's already distributed-enabled environment without mode switching; the runner must not update ECS services, mutate database modes, or add an API to select mode.

**Single bounded distributed workload:** Execute the following checkpoints within one run, using the same submitted job set throughout:

1. Before execution, determine a bounded batch size expected to raise backlog per worker above the configured scaling target at the initial parent capacity. Read the deployed metric definition and target; account for submission rate, processing time, and scaling evaluation/cooldown windows within the job/runtime budget. Do not use a fixed minimum-two-job rule. Record the chosen count and rationale before submission, then submit that fixed batch of 720p-or-higher jobs through the existing API/presigned upload flow. Do not add jobs during the run to adjust load or trigger scale-out.
2. Observe the parent worker service scale from one to at least two healthy running tasks through the existing autoscaling policy. Correlate job IDs, task identities, and timestamps to prove different parent workers coordinate different jobs concurrently.
3. For at least one job from that batch, correlate its attempt and Step Functions execution with distinct child task ARNs for 360p and 720p. Use existing Step Functions execution history and ECS task execution timestamps to verify overlapping child execution intervals. This demonstrates concurrent child execution; measuring FFmpeg encode-phase overlap is not required. Do not add E2E-specific application instrumentation.
4. Verify that job's parent master publication and API COMPLETED, then load its published output through CloudFront/video.js. Verify master/media/segment requests, decoding and positive media-time advancement, both renditions, and a rendition switch.
5. Account for every submitted job and wait for all of them to reach API COMPLETED within the run deadline. Then confirm normal parent-service scale-in to the configured minimum after work finishes and cooldown expires. Observe continuously so an earlier natural scale-in during browser playback is recorded; do not delay application work or alter autoscaling to force a test order.

A desired-count increase, child success, Step Functions success, or Visible=0 alone is insufficient evidence of the corresponding processing/completion checkpoint. Observe existing task protection where exposed without forcing termination. Do not submit a separate playback batch or duplicate Task 04's delivery matrix or Task 24's component publication tests.

**Evidence and limits:** Use one bounded distributed run for scaling, child overlap, publication, playback, all-job completion, and scale-in evidence. Do not add a performance benchmark, comparison run, or failure matrix. Record fixture identity/duration, the configured scaling target and metric definition, predetermined batch size and selection rationale, image, region, observation window, task counts, per-job elapsed time, child task ARNs and Step Functions/ECS execution timestamps establishing overlap, browser evidence, and pass/fail/timeout reasons. Record measured results without requiring a speedup or p50/p95/cost-model project. Fix workload size and deadlines before execution based on exceeding the configured backlog-per-worker target within the agreed budget. Do not increase the batch size during execution. A larger planned batch is not itself evidence that scale-out occurred. If limits cannot demonstrate scale-out, report the unmet acceptance criterion rather than retuning infrastructure or manufacturing load indefinitely.

**Responsibility boundaries:** Tasks 01-24 remain owners of product behavior and focused component validation; Task 89 owns environment Terraform and provisioning instructions; Task 90 owns only the integrated suite and evidence. Existing Reliability E2E remains unchanged and independently owned; reference its existing acceptance evidence instead of reproducing duplicate-delivery, crash/lease/heartbeat, retry/DLQ, FFmpeg/S3/database failures, ambiguous starts, or stale-child matrices. Distributed stale-attempt fencing remains covered by existing component tests, not a new E2E fault-injection suite.

**Cleanup:** Track run-owned job/object identifiers and clean only safely unreferenced run artifacts using existing mechanisms. Do not delete published results while referenced, purge queues, stop unrelated tasks, or destroy the environment. On timeout stop submissions, report remaining jobs/executions, and hand off unresolved workload status to the operator and follow existing operational procedures before environment teardown. Do not report a partial or skipped run as full Phase 3 acceptance.

### Acceptance Criteria

**Definition of Done:** Meet these criteria and Validation/Final Verification. Report unexecuted live checks separately.

- A separately selected Scalability E2E project runs against Task 89's environment; Reliability E2E files, selectors, behavior, and execution responsibilities remain unchanged.
- --check is offline and contains no embedded test suite; --full requires explicit dedicated-environment opt-in and bounded job/runtime settings. Scenario/helper tests live under frontend/e2e.
- The bounded batch size is determined and recorded before execution from the configured backlog-per-worker target, with a rationale for exceeding that target and no additional jobs submitted to adjust load during execution. The single batch uses 720p-or-higher sources and proves parent-service scale-out from one to at least two running workers and concurrent coordination of distinct jobs by distinct workers.
- Every submitted job reaches API COMPLETED, and the parent service returns to its configured minimum after work finishes within bounded observation time. Missing, failed, or unfinished jobs prevent PASS.
- At least one job in that same batch identifies distinct 360p/720p child task ARNs and overlapping execution intervals from existing Step Functions/ECS timestamps, followed by a published master and API COMPLETED. No E2E-specific application instrumentation or encode-phase timing is required; child or Step Functions success alone is insufficient for job completion.
- Browser evidence from that same job proves distributed ABR master/variants/segments through CloudFront, actual decoding/time advancement, and a rendition switch.
- Evidence lists every required scenario as PASS, FAIL, or NOT RUN with identifiers and timestamps. The single distributed workload must cover scaling, encoding, and playback for full acceptance; missing live access is not PASS.
- No Reliability failure matrix, new fault injector, Terraform mutation, application repair, scaling algorithm, or duplicate component suite is introduced. Report blockers to Tasks 01-24 or 89 as appropriate.
- Required Phase 3 completion requires review of this suite's live evidence. Task 99 remains optional and follows accepted Task 90.

### Validation

Run these offline checks from the repository root. These are future implementation checks, not evidence that AWS acceptance has run.

```text
python app/scripts/run_scalability_e2e.py --check
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
npm --prefix app/frontend run test:e2e -- --project=scalability --list
npm --prefix app/frontend run test:e2e -- --list
python app/scripts/validate_contracts.py
```

# Final Verification

```text
python app/scripts/run_scalability_e2e.py --check
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
npm --prefix app/frontend run test:e2e -- --project=scalability --list
npm --prefix app/frontend run test:e2e -- --list
python app/scripts/validate_contracts.py
```

Verify the diff stays within allowed paths and Reliability E2E behavior is unchanged. Repeat the Validation commands after any corrective changes; do not count skipped or unexecuted checks as PASS.

**Live acceptance:** After Task 89 readiness of the Task 24-complete, distributed-enabled environment, run `python app/scripts/run_scalability_e2e.py --full` with the documented bounded distributed workload. Review evidence for parent-service scale-out/in, concurrent child execution, and CloudFront/video.js ABR playback from the same workload. Use the single predetermined batch of 720p-or-higher jobs sized against the configured scaling target, without adding jobs mid-run; acceptance requires every checkpoint, all submitted jobs COMPLETED, and return to minimum capacity. No mode switching or separate workload run is performed. Do not run Reliability E2E as part of this suite. Unexecuted live checks must be reported separately from harness implementation completion.
