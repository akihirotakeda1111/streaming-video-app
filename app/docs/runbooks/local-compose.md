# Local Docker Compose runtime

The local Compose stack runs PostgreSQL, migrations, the Go API, the Rust
worker, the Vite frontend, and AWS Emulator. S3, SQS, and CloudFront-style
playback stay on the local machine through the emulator and its loopback proxy.
The separate `compose.yaml` base remains suitable for AWS-backed E2E runs.

## Local configuration

Use `.env.local` for the local emulator stack. Set the local bucket names,
queue URL, and frontend origin there; leave AWS access keys empty because the
emulator supplies local credentials. Do not use the emulator overlay for
AWS-backed E2E runs.

The two database URLs intentionally use different hosts:

- `DATABASE_URL` uses `localhost` for processes running on the host.
- `COMPOSE_DATABASE_URL` uses `postgres` for containers on the Compose network.

Start the complete local stack from the `app` directory:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.local-emulator.yaml up --build -d
docker compose --env-file .env.local -f compose.yaml -f compose.local-emulator.yaml ps
```

The frontend is available at `http://localhost:5173` and the API health endpoint
at `http://localhost:8080/api/v1/health` by default.

Use the same `--env-file` and both `-f` arguments when checking logs or stopping
the stack:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.local-emulator.yaml logs -f api worker frontend
docker compose --env-file .env.local -f compose.yaml -f compose.local-emulator.yaml down
```

The migration container records applied versions in PostgreSQL. If an older,
disposable local volume already contains tables that were created manually,
remove that volume before the first migration-managed startup. Running
`docker compose down --volumes` deletes all local PostgreSQL data.

## AWS-backed E2E configuration

CI and Reliability E2E use `compose.yaml` without the local emulator overlay.
They pass repository configuration directly to Compose and do not create or
commit an environment file.

Repository variables:

- `AWS_REGION`
- `VIDEO_ENCODING_QUEUE_URL`
- `VIDEO_INPUT_BUCKET`
- `VIDEO_OUTPUT_BUCKET`

Repository secrets:

- `AWS_E2E_API_ACCESS_KEY_ID`
- `AWS_E2E_API_SECRET_ACCESS_KEY`
- `AWS_E2E_WORKER_ACCESS_KEY_ID`
- `AWS_E2E_WORKER_SECRET_ACCESS_KEY`

The workflow maps those secret names to the service-specific Compose inputs
`API_AWS_*` and `WORKER_AWS_*`. No AWS credential is passed to the frontend.
