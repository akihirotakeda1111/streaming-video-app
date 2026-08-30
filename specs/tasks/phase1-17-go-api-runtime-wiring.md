---
schema_version: 1
id: phase1-go-api-runtime-wiring
title: Phase 1 Go API PostgreSQL and AWS Runtime Wiring
status: PENDING
base_branch: dev
target_branch: feature/phase1-go-api-runtime-wiring

allowed_paths:
  - app/backend/api/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/infra/**
  - app/backend/worker/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Make the create-video endpoint reachable in the locally executed Phase 1 API after `phase1-go-api-create-video-endpoint` has been merged into `dev`.

# Non-Goals

- Do not implement status or playback endpoint behavior.
- Do not modify or automatically apply database migrations.
- Do not create AWS resources, credentials, access keys, or Terraform changes.
- Do not add retries, authentication, CloudFront, SQS publishing, or source upload proxying.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, worker, frontend, agent code, or GitHub Workflows.
- Do not hard-code physical bucket names, AWS credentials, database credentials, or region values.
- Do not start serving requests when required runtime dependencies cannot be initialized.
- Do not contact live AWS services from unit tests.
- If requirements conflict with a contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-go-api-create-video-endpoint` is a prerequisite and must already be merged into `dev`.
- The existing Phase 1 SQL migration is applied manually before API startup; migration execution remains outside this work unit.
- `DATABASE_URL`, `AWS_REGION`, and `VIDEO_INPUT_BUCKET` are the authoritative runtime inputs.
- AWS credentials use the standard credential provider chain and are never stored in repository files.
- The concrete PostgreSQL repository and S3 presigner are injected into the HTTP router.
- Graceful shutdown releases the HTTP server and database resources.

# Tasks

## api-runtime-wiring: Connect PostgreSQL, AWS, service, and router

### Requirement

Wire `cmd/api` to open and verify PostgreSQL, load AWS SDK configuration for the configured region, create the S3 presigner adapter, construct the repository and create-video service, and inject the endpoint into the HTTP router. Fail startup clearly when database connectivity, required schema, or dependency construction is unavailable.

### Acceptance Criteria

- The runtime opens PostgreSQL from `DATABASE_URL`, verifies connectivity, and verifies the required `videos` and `jobs` tables before serving.
- AWS SDK configuration uses `AWS_REGION` and the default credential provider chain.
- The S3 presigner uses `VIDEO_INPUT_BUCKET`; no client-selected bucket is accepted.
- `POST /api/v1/videos` is reachable through the production `cmd/api` handler tree.
- Startup fails before listening when PostgreSQL, schema, AWS configuration, repository, or signer construction fails.
- Shutdown closes the HTTP server and database pool without leaking secrets.
- Tests inject fake database, AWS configuration, signer, repository, and server boundaries and do not contact live services.

### Validation

```text
go test -C app/backend/api ./...
```

# Final Verification

```text
python app/scripts/validate_contracts.py
go test -C app/backend/api ./...
```
