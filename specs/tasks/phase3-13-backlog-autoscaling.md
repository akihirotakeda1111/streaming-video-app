---
schema_version: 1
id: phase3-backlog-autoscaling
title: Phase 3 SQS Backlog per Worker Autoscaling
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-backlog-autoscaling

allowed_paths:
  - app/infra/terraform-compute/**
  - app/scripts/validate_terraform_contracts.py
  - app/docs/runbooks/worker-scaling.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Use simple bounded target tracking on SQS backlog per service task, calibrated with measured processing time.

**Priority:** P1. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- Do not create test code under `app/scripts/`, including standalone test files or test suites embedded in validators/runners. Preserve functional validators and execution entrypoints.
- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.


# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validator and component tests. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** `phase3-fargate-worker-service` (`phase3-12-fargate-worker-service.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## backlog-autoscaling: Phase 3 SQS Backlog per Worker Autoscaling

depends_on: []

### Requirement

**Validation ownership:** Implement scaling checks in the existing Terraform contract validator against the actual configuration. Do not add a separate negative-fixture suite or embed such a suite in the validator. Live scaling evidence remains required.

**Runtime handoff:** Prerequisites are Task 10's application protection/concurrency behavior and Task 12's deployed worker configuration, IAM, and endpoint wiring. Add scaling policy, metric wiring, capacity bounds, and cooldowns here; do not implement another protection loop or alter the runtime configuration interface. Validate scale-in/out using the already-integrated worker. If application or worker-deployment changes are needed, report them to the owning task rather than widening this scope.

**Scope / Allowed Changes:** Add an Application Auto Scaling target/policy for the ECS service. Divide visible SQS backlog by `ECS/ContainerInsights` RunningTaskCount for the exact ClusterName/ServiceName using metric math. Enable Container Insights and document its cost; do not add a Lambda aggregation service. Specify metric periods, statistics, and dimensions and compare observations with queue attributes. Do not convert missing data or a zero divisor into zero load. Use min=1, max=4, and initial CLI concurrency=1.

Start the target at acceptable queue delay divided by measured representative processing time. Keep it positive and explain that variable video lengths and multi-record SQS messages make this an approximate workload measure. Configure bounded scale-out/scale-in cooldowns accounting for startup, processing, and protection. Visible=0 does not imply no work in progress; retain scale-in protection and use NotVisible/oldest age for diagnostics. Terraform must not repeatedly reset autoscaler-controlled desired_count.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Under load, running capacity rises above one without exceeding four, then returns to the minimum within a bounded observation window after draining.
- Idle, missing metrics, zero RunningTaskCount, and startup failure do not cause erroneous rapid scale-in or unbounded growth; expose diagnostic evidence.
- Backlog from duplicates/poison is not a database attempt counter. Preserve existing DLQ and age alarms.
- Reject configurations that repeatedly interrupt active jobs during normal scale-in. Preserve Phase 2 recovery after forced termination.
- Implement `--stage scaling` in the existing validator to reject wrong dimensions, missing-data-as-zero, unbounded capacity, and missing protection integration in the configuration. A separate negative-fixture suite is not required.
- In distributed mode, count coordinator service tasks in the denominator, not single-shot encoders. Re-measure processing time and targets in Tasks 24/90.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
python app/scripts/validate_terraform_contracts.py --stage scaling
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
python app/scripts/validate_terraform_contracts.py --stage scaling
python app/scripts/validate_contracts.py
```

**Live acceptance:** An operator submits a small bounded burst and records queue depth/age, desired/running capacity, scaling activities, completions, database connections, and estimated cost. Do not promise an unmeasured speedup.
