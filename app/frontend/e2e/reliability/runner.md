# Reliability E2E runner

`app/scripts/run_reliability_e2e.py --check` is offline only. It checks for
`node`, `npm`, `npx`, and `ffmpeg`, and validates any supplied `E2E_*` values.
Missing live settings are reported as not configured; no AWS, database, queue,
browser, container, or service is contacted.

Live execution requires `E2E_ENVIRONMENT=disposable` and
`E2E_RELIABILITY_DISPOSABLE=true`, complete non-secret resource identities, a
matching `E2E_SOURCE_DLQ`/`E2E_DLQ` relationship marked
`E2E_SOURCE_DLQ_RELATIONSHIP=verified`, `E2E_MAX_ATTEMPTS`, alarm identifiers,
bounded timeout settings, and explicitly test-owned
`E2E_WORKER_CONTROL_SCOPE`/`E2E_DATABASE_CONTROL_SCOPE` values. It also
requires an absolute run-owned `E2E_EVIDENCE_DIR`. The runner validates these
before invoking Playwright and never edits source, Compose, IAM, networking,
Terraform, or queues.

Implemented selectors are shown by `--list`: `preflight` runs the local/browser
preflight and `runtime-authorization` runs the reliability authorization test.
Additional failure scenarios are intentionally unavailable until their
successor specs provide selectors and adapters. Evidence belongs in the
run-owned evidence directory; diagnostics must use the existing redaction
helpers and must not contain credentials, receipt handles, database URLs, or
full presigned URLs.

Worker and database controls are identifiers for documented, disposable
process/service boundaries only. They do not authorize killing unrelated
processes or shared services. Cleanup is limited to canonical resources
registered by the current run through `RunResources`.
