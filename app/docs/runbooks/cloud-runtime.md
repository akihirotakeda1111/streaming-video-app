# Cloud runtime deployment

The compute root owns its own state at `app/infra/terraform-compute` and consumes
the S3/SQS/CloudFront outputs from the existing root through `shared_state_path`.
It creates a public-subnet ECS API and ALB, while RDS is Single-AZ and private.
Tasks have public IPs so this MVP needs no NAT Gateway; this lowers idle cost but
exposes task egress directly and is not the preferred production topology.
Worker ingress is closed and its security-group interface is reserved for the
worker cloud-runtime task.

Before planning, push the API image and supply its immutable digest. The
`aws_ecr_image` lookup makes a missing digest fail planning. Supply an ACM
certificate ARN in the ALB region and configure DNS to the `api_base_url` output.
`frontend_origin` must be the exact browser origin; it is passed to the API and
must match the shared delivery CORS configuration.

Create an application database role and a Secrets Manager value containing its
TLS URL (`postgresql://...?...sslmode=verify-full`, with the RDS CA trust path
appropriate to the image). Do not put the RDS-managed administrator secret in
Terraform variables, task definitions, outputs, or logs. Operators may read
that service-managed secret only to bootstrap the application role.

Run the migration task once, using the `migration_task_definition` output, with
the same public subnet, API security group, and database secret. It applies
`0001_phase1_schema.up.sql` and `0002_job_lease_persistence.up.sql`; wait for a
successful stopped task before setting the API service desired count above zero.
The API uses the existing runtime TLS behavior unchanged and receives only the
application `DATABASE_URL` secret, never RDS administration credentials.

For a small MVP budget, start with one `db.t4g.micro`, 20 GiB, one API task,
seven-day logs, and no NAT Gateway. Stop the API service and RDS when idle (or
set desired count to zero and stop the database carefully); preserve snapshots
before removing RDS. Operators own DNS, ACM issuance/renewal, image pushes, and
live TLS/database connectivity checks. Offline Terraform contract checks do not
prove provider readiness or live TLS connectivity.
