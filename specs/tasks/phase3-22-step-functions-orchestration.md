---
schema_version: 1
id: phase3-step-functions-orchestration
title: Phase 3 Step Functions Fargate Orchestration
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-step-functions-orchestration

allowed_paths:
  - app/infra/terraform-compute/**
  - app/scripts/validate_terraform_contracts.py
  - app/docs/runbooks/distributed-encoding.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Define bounded rendition launch, join, and failure propagation with Standard Step Functions and an Inline Map of at most two Fargate tasks.

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

**Preconditions / Dependencies:** `phase3-rendition-encoder` (`phase3-21-rendition-encoder.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## step-functions-orchestration: Phase 3 Step Functions Fargate Orchestration

depends_on: []

### Requirement

**Validation ownership:** Use the existing Terraform contract validator for ASL/IAM/configuration checks and the documented dedicated-environment execution for orchestration acceptance. Do not add or embed a separate validator test suite.

**Scope / Allowed Changes:** Add a single-shot encoder task definition using Task 21's entrypoint, restricted roles, and a Standard state machine. Accept one or two renditions, set Map MaxConcurrency=2, and use optimized `ecs:runTask.sync` for each iteration. Do not add Distributed Map, Batch, Lambda encoders, or child queues.

For each Map item, project the parent orchestration input into exactly the Task 01 child payload fields: `video_id`, `job_id`, `attempt`, `execution_id`, `rendition`, `source_key`, and `output_prefix`. Set `rendition` from the current Map item and derive `output_prefix` as `{parent.output_prefix}/{rendition}`. Do not pass the parent `renditions` array or `deadline_at` to the child.

Serialize this child payload to a JSON string within the Step Functions definition and pass it to the ECS task only through the state-machine-controlled container environment override `CHILD_PAYLOAD_JSON`. The child task definition must use a fixed wrapper that writes this value to stdin and invokes Task 21's existing `video-worker encode-child -` entrypoint. Do not accept command, entrypoint, task-role, or arbitrary environment overrides from orchestration input, and do not log the complete serialized child payload.

Set finite timeouts on Task states and the state machine, bounding the Map through the execution deadline. Do not add an unsupported TimeoutSeconds field to a Map state. Treat nonzero container exits and RunTask Failures as failures and route Catch handling to terminal failure. Initially configure no child-level retries; parent job retry owns recovery. The workflow must not acknowledge SQS, complete the database job, or publish the master. Task 24 owns validation of actual child result descriptors.

Grant the state-machine role RunTask for the intended task definition/cluster, required DescribeTasks/StopTask permissions, EventBridge permissions for synchronous completion, and restricted iam:PassRole. Where an AWS action requires wildcard resources, document why and apply supported cluster or other conditions. Add only relevant Start/Describe/StopExecution permissions to the parent role. Restrict child PutObject to `videos/*/jobs/*/hls/attempts/*/*/360p/*` and `videos/*/jobs/*/hls/attempts/*/*/720p/*`, excluding the parent master. Grant input read but no database or SQS access.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

- Reject unsupported rendition identifiers in orchestration inputs using Task 01's allowed IDs; this check belongs here and at the Task 21 encoder boundary, not in Task 20 persistence/playback.

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Accept only one/two valid rendition inputs; reject larger arrays and arbitrary command/task-role overrides.
- Each iteration launches a distinct ECS task running real FFmpeg rather than a Lambda encoder.
- Timeout, RunTask Failures, nonzero exit, and one-sided Map failure cannot report workflow success.
- Document bounded residual-task inspection/cleanup; do not assume stopping an execution guarantees child termination.
- Implement `--stage orchestration` covering delivery, compute, scaling, ASL, and IAM. An empty Pass-only workflow cannot satisfy validation.
- Correlate execution/job/attempt/rendition/task identifiers without logging complete payloads or secrets.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
python app/scripts/validate_terraform_contracts.py --stage orchestration
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
python app/scripts/validate_terraform_contracts.py --stage orchestration
python app/scripts/validate_contracts.py
```

**Live acceptance:** In a dedicated environment, run a two-rendition payload and inspect execution history, distinct task ARNs, overlapping execution times, and residual tasks after failure or StopExecution. Do not publish browser playback at this stage.
