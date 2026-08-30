---
schema_version: 1
id: phase1-infra-local-runtime
title: Phase 1 Local Runtime Foundation
status: PENDING
base_branch: dev
target_branch: feature/phase1-infra-local-runtime

allowed_paths:
  - app/infra/**
  - app/compose.yaml
  - app/.env.example

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/scripts/validate_terraform_contracts.py
  - app/backend/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Define the local PostgreSQL runtime, shared non-secret configuration, and single Terraform root foundation required before the Phase 1 AWS resources are added. The Go API, Rust worker, PostgreSQL, and Vue frontend remain locally executed in Phase 1.

# Non-Goals

- Do not create, rewrite, or extend shared contracts or their examples.
- Do not add S3, SQS, IAM execution identities, RDS, ECS/Fargate, ECR, ALB, CloudFront, OAC, a DLQ, redrive policy, retries, leases, visibility-timeout heartbeats, worker autoscaling, Step Functions, EventBridge Pipes, CloudWatch alarms, or custom lifecycle events.
- Do not deploy or modify API, worker, or frontend source code.
- Do not initialize, validate, plan, apply, destroy, or otherwise execute Terraform from the Agent pipeline.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, shared contracts, contract fixtures, Execution State, agent runtime code, GitHub Workflows, or architecture documentation.
- Do not run Terraform CLI commands, including `terraform init`, `terraform fmt`, `terraform validate`, `terraform plan`, `terraform apply`, `terraform destroy`, `terraform import`, `terraform state`, or `terraform workspace`.
- Do not run AWS CLI mutation commands or otherwise change deployed infrastructure.
- Do not commit credentials, passwords, presigned URLs, or environment-specific secrets.
- If implementation requirements conflict with an existing contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `app/contracts/openapi/api.yaml`, `app/contracts/domain/job-status.schema.json`, `app/contracts/domain/storage-conventions.md`, and `app/contracts/examples/**` are fixed, read-only inputs.
- PostgreSQL runs locally for Phase 1 and remains the shared source of truth for video and encoding-job metadata.
- Terraform under `app/infra/terraform/` is the single AWS infrastructure root.
- Terraform CLI execution is outside the Agent validation boundary and requires human verification before merge.
- Shared environment configuration contains names and endpoints but no real credentials.

# Tasks

## local-runtime: Define local PostgreSQL and shared configuration

### Requirement

Define the local PostgreSQL service and non-secret environment-variable template required by the Go API and Rust worker. Create the single Terraform root and its provider, version, variable, local, and output foundations without contacting AWS or changing infrastructure.

### Acceptance Criteria

- `app/compose.yaml` defines a local PostgreSQL service with a health check and persistent development volume.
- `app/.env.example` documents database, AWS region, queue URL, input bucket, output bucket, frontend origin, API base URL, FFmpeg path, and temporary-directory configuration without real credentials.
- API and worker configuration names are consistent with the fixed contracts and directory-structure ADR.
- The local runtime does not introduce RDS, ECS/Fargate, CloudFront, DLQ, Redis, or DynamoDB.
- Terraform configuration is limited to the required Phase 1 foundation and is subject to human Terraform verification before merge.

### Validation

```text
python app/scripts/validate_terraform_contracts.py --stage foundation
```

# Final Verification

```text
python app/scripts/validate_terraform_contracts.py --stage foundation
```
