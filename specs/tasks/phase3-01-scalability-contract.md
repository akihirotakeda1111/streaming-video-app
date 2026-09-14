---
schema_version: 1
id: phase3-scalability-contract
title: Phase 3 Contracts and Architecture Delta
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-scalability-contract

allowed_paths:
  - app/contracts/**
  - app/scripts/validate_contracts.py

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/docs/adr/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Define the contract and architecture deltas for CloudFront delivery, horizontal scaling, and two-rendition parallel encoding on the completed Phase 2 baseline. Give implementation tasks explicit boundaries for ownership and public API compatibility.

**Priority:** P0. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.
- Do not create or update files under `app/docs/adr/`.

# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python contract validator. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** the completed Phase 2 baseline on main (no Phase 3 dependency) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.

Read the existing storage/reliability conventions and OpenAPI contract as the source of truth. Historical ADRs may be read for context, but this task does not create or update them. Do not introduce a new Task Spec format or a separate state-management framework.

# Tasks

## scalability-contract: Phase 3 Contracts and Architecture Delta

depends_on: []

### Requirement

**Scope / Allowed Changes:** Update the existing storage and reliability conventions and OpenAPI descriptions/examples. Add `app/contracts/domain/scalability-conventions.md` and internal orchestration payload schemas/fixtures. The new document owns only the scalability and delivery deltas and references the existing status and lease definitions. Extend the existing `validate_contracts.py` only as needed to check consistency with the public API, existing storage keys, and reliability contract. A separate validator test suite is not required. Do not create or update ADR files.

**Minimum architecture:** Keep SQS Standard feeding the existing Rust worker, deployed as an ECS/Fargate service. The worker continues to own S3 event validation, atomic claim/acquisition, SQS and database heartbeats, retry, non-acknowledgement for redrive, final completion, and acknowledgement. In the distributed mode, it starts and monitors a Standard Step Functions execution. An Inline Map with a maximum concurrency of two launches one single-shot Fargate encoder per rendition. Each child owns source download, one FFmpeg CLI encode, and upload to its assigned prefix. Children receive no receipt handles, database credentials, or completion authority. The parent validates their results, publishes the master last, and atomically commits the published manifest pointer and completion with owner/attempt predicates.

**Storage delta:** Preserve the source key and `hls/index.m3u8` for existing completed single-rendition jobs. Only distributed mode adds `hls/attempts/{attempt}/{execution_id}/{rendition}/index.m3u8`, sibling `segment-{nnnnn}.ts` objects, and a parent master at `hls/attempts/{attempt}/{execution_id}/index.m3u8`. Add an internal nullable `published_manifest_key`; NULL on an existing completed legacy job resolves to its original key. A distributed completion must have a pointer. Isolating attempts prevents late child uploads from overwriting another attempt. Do not move or rename existing objects.

**Delivery:** Define `PLAYBACK_BASE_URL` as an HTTPS delivery origin, separate from S3 SDK endpoints. Do not insert the bucket name into CloudFront paths. Preserve the response shape, including `manifestUrl`, the five public statuses, and the 409 not-ready response. The output bucket is private and OAC signs requests to its S3 REST origin. Viewer delivery remains public HTTPS; viewer authentication and signed cookies are out of scope. The API not-ready gate is not authorization for guessed CloudFront URLs.

**Modes and retries:** Default to the existing CLI path initially and enable distributed mode explicitly per deployment. Persist a job's mode once at first processing and keep it fixed across retries. Only a successful SQS-driven job reacquisition increments the job attempt. Initially configure no child task retries; a child failure returns to the parent's existing retry policy. Resolve a lost StartExecution response using a deterministic job/attempt execution name and identical immutable input. Execution cancellation is best effort and cannot serve as the only fence.

**Scaling:** Start with one received message at a time per ECS service task and validate all concurrency bounds. Derive a backlog-per-task target from measured CLI processing time and acceptable queue delay. Use min=1 and max=4 as initial learning-environment limits; defer scale-to-zero. In distributed mode the service tasks are coordinators: four parents with at most two children each imply a normal maximum of eight active encoders. Track residual tasks from failed executions separately and prevent unbounded overlap.

**Cloud runtime:** The current database runs in local Compose and the Rust adapter uses NoTls. Add verified TLS before cloud deployment. Define a dedicated VPC, a small private Single-AZ PostgreSQL RDS instance, the existing API on Fargate with an HTTPS ALB, and a worker service. Moving the existing API makes the shared private database reachable without reimplementing API functionality or splitting services. Treat ACM certificates, frontend origin, image digests, and other environment values as operator-supplied inputs.

**Allowed Changes:** Limit changes to the shared contract files and the existing contract validator listed in frontmatter. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Correct storage-contract language that assigns CloudFront to Phase 2; retain the completed Phase 2 reliability baseline. No ADR creation or update is required.
- Define consistent input/output schemas, legacy/new manifest keys, delivery URLs, fixed job modes, parent/child ownership, and failure/acknowledgement tables.
- Limit additional prefixes to distributed mode. Preserve legacy relative segment references, MIME types, and six-second VOD output.
- Use fixed internal rendition IDs `360p` and `720p` with those resolution ceilings. Do not upscale; small sources may use one rendition. Require a source of at least 720p for two-way parallel validation.
- Bound parent work by an overall deadline within the SQS visibility lifetime measured from receipt. Do not assume heartbeats allow indefinite extension.
- Specify CloudFront cutover, additive database migration, old-worker draining, new-mode enablement, and rollback that retains private S3.
- The existing contract validator checks consistency among the updated contracts, public API, storage keys, and reliability rules, including internal-field isolation, allowed output prefixes, publication ordering, and supported modes. Do not require a separate positive/negative fixture suite.

### Validation

Run the existing contract validator from the repository root to check the updated contract set.

```text
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
python app/scripts/validate_contracts.py
```

**Live acceptance:** This task requires contract validation only. Dependent integration tasks establish actual AWS behavior; never report unexecuted live checks as successful.
