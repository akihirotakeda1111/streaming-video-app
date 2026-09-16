# Worker runtime handoff

The worker reads `WORKER_MAX_CONCURRENCY` as a positive integer from 1 through
32. It defaults to `2` for local Compose. The later ECS service deployment may
set it to `1`; CPU, memory, ephemeral storage, desired count, and scaling
policies are owned by the infrastructure tasks.

## Database TLS

`DATABASE_URL` is passed unchanged to both the Rust worker and the Go API
driver. Local Compose explicitly uses `sslmode=disable`, which is the only
configuration in which the Rust adapter uses `NoTls`. Every other mode uses
hostname-verified TLS. Set `DATABASE_CA_CERT_PATH` to a PEM CA bundle for a
private cloud CA; an unreadable, malformed, expired, or mismatched certificate
fails startup and is never downgraded to plaintext. The Go `pgx` driver uses
the URL's standard `sslmode` and `sslrootcert` parameters, so the API and
worker must receive the same database TLS configuration.

Cloud deployments must use `sslmode=verify-full` and provide the CA through
the task's credential/configuration boundary. Do not put database passwords,
CA material, or static AWS keys in this file.

## Runtime bounds and shutdown

Concurrency is bounded by `WORKER_MAX_CONCURRENCY`. Lease and SQS heartbeat
settings remain bounded by their existing validation. Temporary files are
created below `TMPDIR`, one isolated directory per job, and are removed on
completion or cancellation; FFmpeg is terminated when its owning task is
cancelled. SIGTERM stops receives, cancels active work, and joins for the
worker shutdown grace period (5 seconds); incomplete messages are not
acknowledged and are recovered by lease expiry/redelivery.

The application layer does not create IAM policies or ECS resources. An ECS
service-mode protection adapter, when supplied by the deployment integration,
must acquire protection before receives, renew it while work is active, and
release it only while idle. Local mode must not call an ECS endpoint; cloud
mode must fail closed when that integration is unavailable.
