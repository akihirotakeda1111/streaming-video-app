---
schema_version: 1
id: phase3-scalability-e2e-environment
title: Phase 3 Scalability E2E AWS Environment
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-scalability-e2e-environment

allowed_paths:
  - app/infra/terraform-e2e/scalability/**
  - app/scripts/validate_terraform_contracts.py
  - app/docs/runbooks/scalability-e2e.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/scripts/run_reliability_e2e.py
  - app/scripts/generate_reliability_env.mjs
  - app/scripts/setup_reliability_env.mjs
  - app/infra/terraform/**
  - app/infra/terraform-compute/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Add Scalability E2E configuration under app/infra/terraform-e2e/scalability/ that reuses the existing delivery and compute Terraform definitions unchanged, with dedicated state/resource identities and a handoff for distributed-enabled E2E after Task 24.

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

**Preconditions / Dependencies:** `phase3-abr-publication` (`phase3-24-abr-publication.md`) must be merged into `main` or included through a merged ancestor. Cross-file dependencies are merged-base prerequisites; `depends_on` only describes tasks within this Markdown.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.

# Tasks

## scalability-e2e-environment: Phase 3 Scalability E2E AWS Environment

depends_on: []

### Requirement

**Scope / Allowed Changes:** Add Scalability E2E-specific configuration under `app/infra/terraform-e2e/scalability/**`. Reuse `app/infra/terraform` and `app/infra/terraform-compute` as read-only definitions; do not change any file in either directory. Keep existing Reliability E2E configuration, defaults, resource addresses, state, outputs consumed by its tooling, and commands unchanged. Keep all new Terraform configuration, backend/tfvars examples, and non-secret outputs exclusively under `app/infra/terraform-e2e/scalability/`. Files directly under terraform-e2e and every sibling directory are outside allowed scope; do not add or modify them. Select this separate root explicitly so existing Reliability commands cannot load its configuration. Use functional filenames without phase numbers. This task owns E2E configuration and output wiring, not changes to ordinary/production Terraform or new resource implementations.

**Reuse and state boundary:** Follow the existing terraform-e2e foundation-module reuse pattern to instantiate the existing terraform delivery definition for a separate scalability environment. Add the required non-secret E2E outputs under `app/infra/terraform-e2e/scalability/` (input/output bucket names/ARNs, queue URL/ARN, CloudFront domain/distribution identifier, and any already-supported compute inputs). Feed those dedicated outputs to the unchanged terraform-compute root through its existing input interface. Keep compute backend/state configuration and tfvars examples under `app/infra/terraform-e2e/scalability/`; invoke the existing compute root with those explicit external configuration paths and an E2E-specific environment name. Apply the explicit state and TF_DATA_DIR isolation rules below; changing a tfvars environment name alone does not isolate state. Use separate delivery and compute state identities, both distinct from ordinary/production and Reliability state. Do not wrap the compute root as a child module if its provider/backend structure does not support that use, and do not copy ECS/RDS/Step Functions resources into terraform-e2e. If existing outputs or compute inputs are insufficient, stop and report the missing interface rather than editing the forbidden roots or duplicating resources.

**Compute execution isolation:** Run the existing `app/infra/terraform-compute` root as read-only configuration using its supported backend type. Resolve configuration and runtime paths to absolute paths before using Terraform's `-chdir` option. For every Terraform invocation against this root, set an explicit absolute `TF_DATA_DIR` unique to this scalability environment and the compute root; never use its default `.terraform` directory or a data directory used by ordinary, production, Reliability, or delivery executions. Keep the directory stable for the same dedicated environment across initialization, planning, application, output inspection, and teardown. Use a separate data directory for the scalability delivery root.

`TF_DATA_DIR` isolates backend metadata/provider/module working data; it does not by itself isolate the backend state. Select an explicit scalability-only backend configuration stored under `app/infra/terraform-e2e/scalability/`: for a local backend, use an absolute dedicated state path outside the ordinary/production and Reliability roots; for a remote backend, use a dedicated state key and the existing backend's locking settings. Record the resolved backend identity, state path/key, workspace if applicable, and TF_DATA_DIR for both delivery and compute. Neither environment names nor workspace selection alone replace this explicit state configuration. Do not reuse or migrate an ordinary/production or Reliability state, copy their backend metadata, or fall back to a default state when configuration is missing.

Keep generated state, plans, backend metadata, and credentials outside version-controlled source directories in an operator-selected private runtime directory; do not commit them or emit their contents as evidence. Keep compute tfvars and backend examples under scalability and pass their absolute paths explicitly. Preserve the existing compute dependency lockfile without upgrade or writes; if initialization would require modifying the forbidden root or cannot use the dedicated backend/data directory, stop and report the prerequisite issue. Document the invocation settings in the existing allowed runbook, without adding a wrapper or changing the ordinary root. Before any live plan/apply/destroy, verify the dedicated account/region, resource identity, resolved state destination, and TF_DATA_DIR; missing or conflicting isolation settings block execution.

**Existing implementation ownership:** Tasks 01-04 own contracts and delivery behavior; Tasks 10-13 own runtime, cloud foundation, worker service, and backlog scaling; Tasks 20-24 own persistence, encoders, orchestration, and publication. Consume their completed interfaces. An implementation defect or missing interface that requires redesign is a stop condition for routing to the owning task, not permission to rebuild it here.

**Environment and handoff:** Wire the existing input/output buckets, queue, CloudFront, API/private database, worker service, autoscaling policy, and Step Functions/child task definition into one dedicated deployment. Retain min=1/max=4 parents and at most two children per parent from the existing contract. Record account/region, environment identity, API and CloudFront URLs, bucket/queue identifiers, cluster/service/state-machine/task-definition identifiers, scaling bounds, and image digests using existing outputs where possible. Document how Task 90 consumes these values; never output secrets. Keep frontend hosting out of scope: an operator supplies a reachable frontend origin with existing CORS configuration. Reuse existing bootstrap/migrations including 0003 for a fresh dedicated environment; do not add migrations. The target is a Task 24-complete, distributed-enabled deployment from the outset.

**Operation:** Document operator deployment order using `app/infra/terraform-e2e/scalability/` and its external backend/tfvars files, required images/certificate/DNS/secrets, bounded workload/runtime/cost settings, and teardown order. Reuse existing operator identity and observation permissions; no fault-injection roles or observation services are added. Target only a distributed-enabled environment after Task 24. CLI/distributed switching, mode-transition drain procedures, and legacy-worker cutover are outside this task; do not require them for Task 90. The E2E runner will not apply/destroy Terraform or reconfigure services.

**Validation ownership:** Reuse the existing Terraform contract validator's orchestration stage, extending its checks only to inspect only the new terraform-e2e/scalability configuration and non-secret output wiring if needed, while preserving existing validator behavior for Reliability and ordinary environments. Explicitly verify the dedicated configuration is covered; validating only the unchanged ordinary roots is insufficient. Do not add a new validator framework, stage, standalone test file, or tests embedded in scripts. Static validation does not establish successful deployment.

### Acceptance Criteria

**Definition of Done:** Meet these criteria and Validation/Final Verification. Report unexecuted live checks separately.

- The diff contains no changes under `app/infra/terraform/**` or `app/infra/terraform-compute/**`. All new E2E backend/tfvars/environment configuration and delivery output wiring live exclusively under `app/infra/terraform-e2e/scalability/`; no Terraform files outside that subtree are added or modified.
- Existing Reliability E2E environment, configuration, commands, and resource/state identity remain unchanged and functional; the new configuration is independently selected and cannot alter its defaults.
- Delivery and compute each use dedicated state identities and scalability resource/environment names distinct from Reliability and ordinary/production deployments; verify those identities before deployment.
- Non-secret outputs added under terraform-e2e/scalability feed the unchanged compute input interface. The compute root uses E2E-specific backend/state, tfvars, and environment settings; ECS/RDS/Step Functions definitions are not duplicated.
- Every compute Terraform invocation explicitly uses the dedicated absolute TF_DATA_DIR and backend state path/key; delivery uses separate state and data directories. A different TF_DATA_DIR without a different backend state is not acceptable isolation. Missing configuration fails closed.
- Existing compute source and lockfile remain unchanged; no state migration, ordinary backend metadata reuse, or default-state fallback is permitted. Generated state/plans/metadata stay outside version-controlled source directories.
- The handoff documents every identifier needed for read-only ECS/CloudWatch/Step Functions observation and browser/API access, with no credentials in outputs or evidence.
- Existing scaling and child-concurrency limits remain bounded; cost/runtime limits and operator shutdown instructions are explicit. No new failure injection capability is provisioned.
- Operator instructions prepare a fresh distributed-enabled deployment after Task 24 using existing bootstrap. No CLI/distributed switch or mode-transition drain procedure is required or implemented.
- Existing orchestration-stage static validation passes. Deployment readiness is evidenced separately; full uploads, scaling bursts, and playback scenarios belong to Task 90.

### Validation

Run these offline checks from the repository root. These are future implementation checks, not evidence that AWS acceptance has run.

```text
python app/scripts/validate_terraform_contracts.py --stage orchestration
python app/scripts/validate_contracts.py
```

# Final Verification

```text
python app/scripts/validate_terraform_contracts.py --stage orchestration
python app/scripts/validate_contracts.py
```

Verify the diff stays within allowed paths, every Terraform change is under terraform-e2e/scalability, and Reliability E2E behavior is unchanged. Inspect the documented invocation settings for absolute backend/tfvars paths, dedicated TF_DATA_DIR for every compute operation, and separate state destinations; do not infer state isolation from TF_DATA_DIR alone. Repeat the Validation commands after any corrective changes; do not count skipped or unexecuted checks as PASS.

**Live acceptance:** An operator verifies the ordinary Terraform roots are unchanged, selects `app/infra/terraform-e2e/scalability/`, and deploys the reused definitions with the dedicated delivery/compute backend and tfvars settings, completes existing bootstrap/migrations, and records API health, worker service readiness, deployed scaling/orchestration settings, and non-secret handoff outputs. Verify account/region, both dedicated state identities and distinct absolute TF_DATA_DIR paths, unchanged compute source/lockfile, resource isolation, image versions, and distributed enablement after Task 24. Confirm the existing Reliability configuration/commands and state are untouched; no CLI/distributed switching or drain exercise belongs to acceptance. Do not run the integration scenario suite here or claim AWS readiness from static checks. Missing certificates, secrets, images, or permissions block live acceptance, not justify a substitute platform.
