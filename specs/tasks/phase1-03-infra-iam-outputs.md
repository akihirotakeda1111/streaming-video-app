---
schema_version: 1
id: phase1-infra-iam-outputs
title: Phase 1 Least-Privilege IAM and Runtime Outputs
status: PENDING
base_branch: dev
target_branch: feature/phase1-infra-iam-outputs

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

Define least-privilege IAM policies and non-secret runtime outputs for the locally executed Go API and Rust worker after `phase1-infra-storage-queue` has been merged into `dev`.

# Non-Goals

- Do not create, rewrite, or extend shared contracts or their examples.
- Do not add RDS, ECS/Fargate, ECR, ALB, CloudFront, OAC, a DLQ, redrive policy, retries, leases, visibility-timeout heartbeats, worker autoscaling, Step Functions, EventBridge Pipes, CloudWatch alarms, or custom lifecycle events.
- Do not create long-lived access keys or commit credentials.
- Do not deploy or modify API, worker, or frontend source code.
- Do not execute Terraform from the Agent pipeline.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, shared contracts, contract fixtures, Execution State, agent runtime code, GitHub Workflows, or architecture documentation.
- Do not run Terraform CLI commands or AWS CLI mutation commands.
- Do not grant wildcard administrator permissions, unrestricted `s3:*`, unrestricted `sqs:*`, or `Resource = "*"` permissions.
- Do not give the API SQS consumption or output-bucket write permissions.
- Do not give the worker permission to create client upload credentials or write outside canonical HLS keys.
- If implementation requirements conflict with an existing contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-infra-storage-queue` is a prerequisite and must already be merged into `dev`.
- The API and worker permissions remain separate and least-privilege.
- The API can write only canonical input objects needed for presigned upload.
- The worker can receive and delete encoding messages, read canonical input objects, and write canonical HLS output objects.
- Queue URL, AWS region, and both bucket names are exposed as non-secret outputs.
- Credentials, database passwords, and presigned URLs remain outside Terraform outputs and source control.
- Terraform configuration requires human verification before merge.

# Tasks

## iam-outputs: Define least-privilege local execution identities and outputs

### Requirement

Define least-privilege IAM policies for the locally executed Go API and Rust worker, and expose the non-secret Terraform outputs needed to configure them. Keep credentials outside source control.

### Acceptance Criteria

- The API identity can create presigned `PUT` requests for canonical input-object keys but cannot consume SQS or write HLS output.
- The worker identity can receive and delete queue messages, read canonical input objects, and write canonical HLS output objects but cannot create client upload credentials.
- Queue URL, region, and bucket names are available as non-secret outputs.
- No access key, secret key, database password, or presigned URL is committed.
- API and worker policies are separate resources and contain no administrator policy, unrestricted `s3:*`, or unrestricted `sqs:*` action.
- Terraform configuration is subject to human Terraform verification before merge.

### Validation

```text
python app/scripts/validate_terraform_contracts.py --stage complete
```

# Final Verification

```text
python app/scripts/validate_terraform_contracts.py --stage complete
```
