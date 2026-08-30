# Local Docker Compose runtime

The Compose stack runs PostgreSQL, the database migrations, the Go API, the
Rust worker, and the Vite frontend. S3 and SQS remain real AWS resources.

## Local configuration

Copy `.env.example` to `.env`, or add the new variables to an existing `.env`,
then replace the AWS resource placeholders and credentials. Keep the API and
worker credentials separate so each process can use its least-privilege IAM
identity.

The two database URLs intentionally use different hosts:

- `DATABASE_URL` uses `localhost` for processes running on the host.
- `COMPOSE_DATABASE_URL` uses `postgres` for containers on the Compose network.

Start the complete stack from the `app` directory:

```sh
docker compose up --build -d
docker compose ps
```

The frontend is available at `http://localhost:5173` and the API health endpoint
at `http://localhost:8080/api/v1/health` by default.

View logs or stop the stack with:

```sh
docker compose logs -f api worker frontend
docker compose down
```

The migration container records applied versions in PostgreSQL. If an older,
disposable local volume already contains tables that were created manually,
remove that volume before the first migration-managed startup. Running
`docker compose down --volumes` deletes all local PostgreSQL data.

## GitHub Actions configuration

The E2E workflows pass repository configuration directly to Compose. They do
not create or commit an environment file.

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
