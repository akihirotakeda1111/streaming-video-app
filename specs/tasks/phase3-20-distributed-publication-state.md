---
schema_version: 1
id: phase3-distributed-publication-state
title: Phase 3 Distributed Attempt and Publication State
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-distributed-publication-state

allowed_paths:
  - app/backend/api/internal/persistence/**
  - app/backend/api/internal/httpapi/playback.go
  - app/backend/api/internal/httpapi/playback_test.go
  - app/backend/worker/crates/persistence/**
  - app/backend/worker/crates/worker/src/fakes.rs

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Extend existing job persistence to fix internal `mode` at first successful acquisition and safely commit an attempt-specific published manifest. Preserve the existing lease model and provide durable state for later orchestration without implementing it here.

**Priority:** P1. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- Do not implement distributed runtime selection, orchestration input assembly, execution launch or orchestration name generation, or application rollback by automatically dropping migration 0003 columns.
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

**Preconditions / Dependencies:** `phase3-backlog-autoscaling` (`phase3-13-backlog-autoscaling.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## distributed-publication-state: Phase 3 Distributed Attempt and Publication State

depends_on: []

### Requirement

**Validation ownership:** Keep persistence, migration, pointer, and invalid-key tests in the existing Go/Rust application test suites under the allowed backend paths. Use the existing contract validator for shared-contract consistency; no test code under scripts is required.

**Scope / Allowed Changes:** Add the additive migration `0003_publication_state` for the internal `mode` field and nullable `published_manifest_key`. Limit new columns in `0003_publication_state` to `mode` and `published_manifest_key`; related constraints and compatibility backfill may be included. Do not add execution IDs, orchestration inputs, or other orchestration-state columns by implementation discretion. If another column appears necessary, stop and report the contract/scope issue instead of expanding this migration. The only resolved mode values are `cli` and `distributed`, as defined by Task 01. Do not edit migrations 0001/0002, introduce public statuses/JSON fields, or implement orchestration in this task.

**Mode initialization and immutability:** Backfill jobs that exist before migration to `cli`, with a NULL published pointer. Backfilling pre-migration rows to cli is an explicit compatibility exception to first-acquisition mode resolution. Jobs created after migration may have an unresolved (NULL) mode before their first successful acquisition. Fix that mode atomically with the first successful acquisition; a failed acquisition must not resolve it. Retry/reacquisition must preserve an already-resolved mode. In this task, the existing CLI acquisition path resolves an unset mode to `cli`; selecting `distributed` belongs to subsequent orchestration work. The CLI path must not acquire a persisted distributed job and process it as CLI. Enforce NULL-to-cli resolution and exclusion of distributed jobs inside Rust persistence. Do not propagate `mode` into runtime-facing DTOs or `AcquiredJob`, or require current runtime branching on mode. Runtime-facing type extensions and distributed selection belong to the later distributed integration task (Task 23).

**Completion fencing:** Provide a Rust persistence operation for distributed completion that writes a valid `published_manifest_key` and `COMPLETED` in the same conditional UPDATE/transaction. Require matching job/video identity, `worker_id`, attempt, an unexpired lease, current status `PROCESSING`, and `mode = 'distributed'`. CLI completion must preserve its existing identity/ownership/lease/status predicates and add `mode = 'cli'` and `published_manifest_key IS NULL`, leaving the pointer NULL. Do not require a new `attempt` predicate or an attempt argument/interface change for existing CLI completion in Task 20; preserve any existing safeguards. Neither completion path may resolve or change mode. An expired owner, different owner, already-COMPLETED job, or mismatched/unresolved mode must affect zero rows and leave status and pointer unchanged in both paths. Distributed completion must additionally reject an old attempt with zero rows and unchanged status/pointer; this does not impose a new attempt predicate on CLI completion. CLI completion with a non-NULL pointer must also affect zero rows. Database failure must not expose a partial completion. Preserve the unchanged attempt budget. Callers remain responsible for publishing all required output before invoking completion; output publication itself is not implemented here. The distributed completion operation remains persistence-only until later tasks wire its caller.

**Fail-closed playback:** Read `mode` and the internal pointer through the Go repository. After the existing request validation and job lookup, apply the following rules to recognized public statuses. Preserve existing malformed-request, missing-video, database-error, and unknown-status handling.

| Job status and persisted state | HTTP response and playback resolution |
| --- | --- |
| Non-COMPLETED | 409 `VIDEO_NOT_READY`; no manifest URL |
| COMPLETED + `cli` (including backfilled legacy jobs) + NULL pointer | 200; existing `videos/{video_id}/jobs/{job_id}/hls/index.m3u8` |
| COMPLETED + `distributed` + valid parent master pointer | 200; `published_manifest_key` |
| COMPLETED + `distributed` + NULL or invalid pointer | 500 `INTERNAL_ERROR`; no manifest URL |
| COMPLETED + `cli` + non-NULL pointer | 500 `INTERNAL_ERROR`; no manifest URL |
| COMPLETED + unknown or unresolved NULL mode | 500 `INTERNAL_ERROR`; no manifest URL |

A completed job with an inconsistent mode/pointer is an internal-state error, not work still in progress. Use the existing error envelope; do not expose internal fields or fall back to a legacy key.

Persist `attempt`, not `execution_id`. Derive the expected execution identity for pointer validation exactly as defined by Task 01:

```text
execution_id = job-{job_id}-a{attempt}
```

A valid distributed pointer must be exactly the parent master key for the stored video/job/attempt and this derived identity:

```text
videos/{video_id}/jobs/{job_id}/hls/attempts/{attempt}/{execution_id}/index.m3u8
```

Reject absolute URLs, another video/job, `..`, encoded traversal, and any key outside this exact allowed parent-master location. A rendition playlist or result object is not a parent pointer. Task 20 does not validate rendition identifiers: they are not part of this parent-master path. Tasks 21/22 own encoder/orchestration rendition validation. Deriving the expected identity for persistence/playback validation is within scope; generating and launching orchestration executions is not.

**Persistence support for later reconstruction:** Retain existing persisted `job_id`, `video_id`, and `attempt` together with `mode` so subsequent tasks can derive the same execution identity and reconstruct their inputs according to Task 01. This is a durable-state requirement, not a requirement to extend Rust runtime-facing interfaces in Task 20. Keep Rust acquisition mode handling inside persistence and leave `AcquiredJob` and runtime DTOs unchanged. Task 23 owns any runtime-facing propagation needed for distributed integration. Go persistence may expose mode/pointer internally to the playback handler as required above, without adding public JSON fields. This task does not persist execution identity or orchestration input, add additional immutable-value columns, assemble inputs, generate output prefixes for launch, or start/describe/stop executions. Additional orchestration persistence, if needed later, requires its own explicit task/contract decision rather than expansion of migration 0003. Do not add a generic workflow table or independent state machine.

**Migration and worker cutover:** There must be no interval in which a worker without Task 20's persistence guards can acquire a post-migration NULL-mode job. Use an operator-controlled cutover: pause new job creation, stop old workers from receiving new work, drain or stop in-flight workers using the existing reliability procedure, and confirm all incompatible queue consumers are stopped before applying migration 0003. Prevent automatic restart of those old consumers. Deploy the compatible API and Task 20 worker before resuming job creation and consumption. Keep distributed selection disabled until its owning later tasks are complete. Do not purge the queue or force jobs to COMPLETED. Describe this sequence and its verification evidence in the implementation handoff; adding infrastructure, rollout automation, or files outside allowed paths is not part of this task.

**Rollback:** Rollback means application deployment rollback, not automatic down migration of `0003`. Retain the added columns and an API capable of reading distributed results and their published pointers. Do not automatically drop the columns or deploy an API that can only resolve legacy keys. Worker rollback must retain Task 20-compatible persistence guards; otherwise keep queue consumption stopped. Do not restart an incompatible worker against post-migration NULL-mode or distributed jobs.

**Allowed Changes:** Keep implementation and tests within the existing persistence and playback paths in frontmatter. Do not widen them to implement orchestration, distributed runtime selection, contracts, or infrastructure.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Backfill pre-migration jobs to `cli` as an explicit compatibility exception to first-acquisition resolution. Previously completed jobs with NULL pointers play through CloudFront without moving objects. New jobs retain first-successful-acquisition mode resolution.
- New jobs may remain unresolved before acquisition. The first successful CLI acquisition fixes `mode=cli` atomically, failed acquisition leaves it unresolved, and retry/reacquisition never changes a resolved mode. The existing CLI path does not acquire distributed work as CLI.
- Exercise every row in the playback table: non-COMPLETED returns 409 VIDEO_NOT_READY, valid completed mode/pointer combinations return 200, and invalid completed combinations return 500 INTERNAL_ERROR without a manifest URL or silent fallback.
- Reject absolute URLs, another video/job's key, `..`, encoded traversal, and disallowed parent-master locations. Validate against the stored attempt and `execution_id = job-{job_id}-a{attempt}`; do not require a persisted execution_id or test rendition identifiers in this task.
- Distributed pointer and COMPLETED are written atomically with job/video identity, `worker_id`, attempt, unexpired-lease, PROCESSING, and `mode = 'distributed'` predicates. Distributed completion rejects old attempts with zero rows and unchanged status/pointers.
- CLI completion preserves its existing predicates and adds `mode = 'cli'` and `published_manifest_key IS NULL`; the pointer remains NULL. No new CLI `attempt` predicate, attempt parameter, or runtime-facing interface extension is required. Exercise both paths for expired owners, other owners, already-COMPLETED jobs, and wrong/NULL modes: each affects zero rows with unchanged status/pointers. CLI completion also rejects a non-NULL pointer. Preserve existing CLI regression coverage.
- A failed completion transaction does not commit either field or make an incomplete job playable. Preserve existing CLI acquisition/release/completion and attempt accounting.
- Add only `mode` and `published_manifest_key` columns in migration 0003. Reuse existing job_id/video_id/attempt for later reconstruction; do not add orchestration-state columns or implement input assembly, launch-prefix generation, or Step Functions operations.
- Verify migration compatibility, first-acquisition races, mode immutability, distributed-job exclusion from CLI acquisition, and both mode-specific completion paths on dedicated PostgreSQL using the existing application suites.
- Rust runtime DTOs and `AcquiredJob` remain unchanged. Persistence internally resolves NULL to cli on successful acquisition and rejects distributed CLI acquisition; later runtime propagation belongs to Task 23.
- Provide the operator cutover sequence and evidence/checkpoints that incompatible workers cannot receive post-migration NULL-mode jobs, including prevention of old-worker automatic restart. Do not claim live rollout verification when it was not performed.
- Application rollback retains columns, a distributed-pointer-aware API, and compatible worker guards (or stops queue consumption). Automatic `0003` down migration is not part of rollback.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml
python app/scripts/validate_contracts.py
```

**Live acceptance:** Set TEST_DATABASE_URL explicitly and verify concurrent acquisition, distributed stale-attempt completion rejection, and existing CLI completion guards plus mode/NULL-pointer checks on real PostgreSQL. No new CLI attempt predicate is required. A skipped test due to missing database configuration is not acceptance.
