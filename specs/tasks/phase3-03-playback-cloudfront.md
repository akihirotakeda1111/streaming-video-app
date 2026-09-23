---
schema_version: 1
id: phase3-playback-cloudfront
title: Phase 3 Playback API and Frontend CloudFront Routing
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-playback-cloudfront

allowed_paths:
  - app/backend/api/internal/config/**
  - app/backend/api/internal/httpapi/**
  - app/backend/api/internal/bootstrap/**
  - app/backend/api/cmd/api/**
  - app/frontend/src/**
  - app/frontend/README.md
  - app/compose.yaml
  - app/compose.e2e.yaml
  - app/.env.example
  - app/README.md
  - app/scripts/generate_reliability_env.mjs
  - app/scripts/setup_reliability_env.mjs
  - app/frontend/e2e/reliability/environment-generator.test.ts
  - app/frontend/e2e/reliability/setup-environment.test.ts

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Route the existing playback API through CloudFront and have the frontend play the returned manifestUrl without deriving an S3 URL.

**Priority:** P0. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.


# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validator and component tests. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** `phase3-cloudfront-private-delivery` (`phase3-02-cloudfront-private-delivery.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## playback-cloudfront: Phase 3 Playback API and Frontend CloudFront Routing

depends_on: []

### Requirement

**Scope / Allowed Changes:** Separate the S3 virtual-host/path-style logic in `internal/httpapi/playback.go` from delivery-origin-plus-object-key construction. Propagate `PLAYBACK_BASE_URL` through configuration, bootstrap, wiring, Compose, and environment generation. Do not overwrite `OUTPUT_S3_ENDPOINT` with a CloudFront URL or pass the delivery URL to an S3 SDK.

Require an HTTPS origin in deployed environments; reject user information, query strings, fragments, and paths. Normalize trailing slashes and never insert the bucket name. Allow loopback HTTP only for explicitly local tests. The frontend must not infer an S3 hostname. Preserve response shapes, not-ready responses, upload presigning, status polling, and video.js lifecycle behavior. Task 20 owns pointer support; this task resolves the existing `hls/index.m3u8` path.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Return `https://<distribution>/videos/<video>/jobs/<job>/hls/index.m3u8` for a completed legacy job.
- Reject missing/invalid delivery configuration at startup without silently falling back to public S3.
- Test unwanted bucket insertion, duplicate slashes, query injection, and manifest exposure before COMPLETED.
- Frontend unit tests cover forwarding the CloudFront URL, existing error presentation, and player disposal without reimplementing upload.
- Environment generation distinguishes delivery URLs from S3 endpoints and never emits secrets.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
go test -C app/backend/api ./...
npm --prefix app/frontend run test:unit -- --run
npm --prefix app/frontend run build
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
npm --prefix app/frontend run test:e2e -- --list
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
go test -C app/backend/api ./...
npm --prefix app/frontend run test:unit -- --run
npm --prefix app/frontend run build
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
npm --prefix app/frontend run test:e2e -- --list
python app/scripts/validate_contracts.py
```

**Live acceptance:** Offline/component checks establish implementation completion for this task. Dependent integration validation establishes actual AWS behavior; never report unexecuted live checks as successful.
