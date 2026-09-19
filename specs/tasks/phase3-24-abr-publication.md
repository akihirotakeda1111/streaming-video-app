---
schema_version: 1
id: phase3-abr-publication
title: Phase 3 Two Rendition ABR Publication and Playback
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-abr-publication

allowed_paths:
  - app/backend/worker/**
  - app/frontend/e2e/**
  - app/infra/terraform/**
  - app/infra/terraform-compute/**
  - app/scripts/validate_terraform_contracts.py
  - app/docs/runbooks/distributed-encoding.md
  - app/docs/runbooks/cloudfront-delivery.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Complete the minimum distributed path by assembling two rendition outputs into a master, committing publication only for the owner, and playing ABR through CloudFront/video.js.

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

**Preconditions / Dependencies:** `phase3-worker-orchestration-bridge` (`phase3-23-worker-orchestration-bridge.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## abr-publication: Phase 3 Two Rendition ABR Publication and Playback

depends_on: []

### Requirement

**Validation ownership:** Use the existing Terraform contract validator for delivery/orchestration configuration and the Rust/Go/frontend E2E suites for publication and playback behavior. Do not depend on a separate delivery or orchestration Python test file.

**Scope / Allowed Changes:** Implement the finalizer for Task 23's results. Validate every expected rendition descriptor, media playlist, and referenced segment for existence, size, MIME type, and identity. Permit only relative references within the same attempt. Build a master with BANDWIDTH/RESOLUTION/CODECS matching actual output and upload it last at `hls/attempts/{attempt}/{execution_id}/index.m3u8`. Invoke Task 20's conditional pointer/completion operation, then return success to existing message completion.

If either rendition fails, publish neither master nor pointer. Record all segments, media playlists, parent master, and database commit in that order. A database failure after master upload leaves attempt-scoped unpublished artifacts without affecting the next attempt. Late old-attempt uploads cannot alter the current pointer. Do not copy results back to legacy keys.

Enable caching for immutable attempt-specific media/playlists while retaining TTL=0 for legacy mutable keys. Never re-encode into the same attempt namespace. Direct access to an unpublished attempt is not equivalent to passing the API not-ready gate; confidentiality of guessed viewer URLs is out of scope. Do not automatically expire prefixes referenced by completed pointers. Limit cleanup to verified unreferenced run/attempt resources.

Verify master loading, both renditions, and switching in video.js. A quality-selection UI, large ladders, and codec selection are unnecessary. Small sources may produce a one-rendition master. Document safe enablement of distributed mode here.

When enabling distributed mode, complete the worker coordinator permissions required by Task 23's orchestration bridge.

Grant states:GetExecutionHistory to the worker task role only for executions of the configured Phase 3 orchestration state machine so Task 23 can recover the ECS task ARNs launched by prior attempts.

Grant the worker task role the minimum ECS permissions required by Task 23 residual-child recovery: ecs:DescribeTasks to confirm the live state of child encoder tasks and ecs:StopTask to request cleanup of confirmed residual child tasks. Restrict these permissions to the configured Phase 3 ECS cluster using the narrowest resource scope and supported cluster conditions consistent with the existing infrastructure policy.

Preserve the existing restricted states:StartExecution, states:DescribeExecution, and states:StopExecution permissions. Do not broaden Step Functions permissions beyond the Phase 3 orchestration state machine and its executions. Do not grant the worker coordinator general ECS task-management authority outside the Phase 3 encoder cluster.

Distributed mode must not be enabled until the Task 23 orchestration permissions, ECS residual-child inspection/cleanup permissions, and the concrete Task 24 finalizer are all available.

Preserve the existing restricted states:StartExecution, states:DescribeExecution, and states:StopExecution permissions. Do not broaden Step Functions permissions beyond the Phase 3 orchestration state machine and its executions.

Distributed mode must not be enabled until these permissions and the concrete Task 24 finalizer are both available.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- A source of at least 720p creates two child tasks with actual execution overlap and outputs at different resolutions.
- CloudFront serves master, variants, and segments successfully with correct MIME types. Observe real decode of each rendition, positive media-time advancement, and at least one rendition switch.
- Missing objects/descriptors, wrong attempts, one-child failure, stale parents, database failure after master Put, and deletion failure after completion cannot cause invalid publication or repeated encoding.
- Legacy and distributed completed jobs use the same API shape; existing CLI mode remains functional.
- Verify repeated immutable requests using cache headers and bytes/hashes without requiring per-job invalidation.
- Add only the worker coordinator permissions required for distributed finalization and Task 23 orchestration recovery.
- In addition to the parent descriptor/GetObject permissions required by this task, grant states:GetExecutionHistory only for executions of the configured Phase 3 orchestration state machine.
- Grant the worker coordinator the minimum ecs:DescribeTasks and ecs:StopTask permissions required to verify and clean up residual encoder tasks from prior attempts. Scope these permissions to the configured Phase 3 ECS cluster using supported resource restrictions and cluster conditions; unrelated ECS clusters/tasks must remain outside the worker role's effective authority.
- Preserve the existing scoped states:StartExecution, states:DescribeExecution, and states:StopExecution permissions.
- Do not grant child tasks Step Functions control, database access, SQS access, residual-task cleanup authority, or parent-master publication authority.
- Before enabling distributed mode, verify that the worker coordinator can perform Task 23 GetExecutionHistory → ECS task ARN recovery → DescribeTasks → best-effort StopTask recovery without AccessDenied, while unrelated Step Functions executions and ECS resources remain outside its permitted scope.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
go test -C app/backend/api ./...
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
npm --prefix app/frontend run test:e2e -- --list
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage orchestration
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
go test -C app/backend/api ./...
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
npm --prefix app/frontend run test:e2e -- --list
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage orchestration
```

**Live acceptance:** Enable distributed mode for a small number of dedicated jobs and observe children, master, database, CloudFront, and video.js end to end. Report honestly when Fargate startup dominates short videos and no speedup is measured.
