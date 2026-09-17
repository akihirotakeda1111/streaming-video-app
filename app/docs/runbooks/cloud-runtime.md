# Cloud runtime deployment

The compute root at `app/infra/terraform-compute` owns separate state and consumes
S3/SQS/CloudFront outputs through `shared_state_path`. Apply the shared root first.
RDS is Single-AZ, but its private DB subnet group spans two AZs. API tasks and the
ALB use public subnets, as do Worker tasks. Tasks get public IPs for outbound ECR/AWS access, avoiding
an always-on NAT Gateway. Direct task egress is an MVP cost tradeoff. Worker
ingress stays closed; this root deploys the API and Worker services plus a one-off
migration task. Worker has no ALB target or inbound port.

Operators run these commands in Bash with AWS CLI, Terraform, Docker and jq,
using the dedicated account and region. Set `AWS_REGION` consistently. Copy
`terraform.tfvars.example` to `terraform.tfvars` and supply the ACM certificate
in the ALB region, actual frontend origin, account allowlist and application
secret ARN. `shared_state_path` is relative to the compute root. The frontend
origin must also match shared delivery CORS. Configure a certificate-covered API
DNS name pointing to the ALB; its generated hostname in `api_base_url` is not
itself covered by that certificate.

## 1. Create ECR, then push the image

Create an empty application secret with
`aws secretsmanager create-secret --name streaming-video/app-database-url`.
Put the returned ARN in `database_url_secret_arn`; do not add an administrator URL.
Leave image digests unset initially and keep `api_desired_count = 0` and
`worker_desired_count = 0` until the application secret and migrations are ready.
From repo root:

```bash
terraform -chdir=app/infra/terraform-compute init
terraform -chdir=app/infra/terraform-compute plan -target=aws_ecr_repository.api -out=bootstrap.tfplan
terraform -chdir=app/infra/terraform-compute apply bootstrap.tfplan
REPOSITORY=$(terraform -chdir=app/infra/terraform-compute output -raw api_repository_url)
REGISTRY=${REPOSITORY%%/*}
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
# Choose a new tag for every build; tags are immutable.
IMAGE_TAG=foundation-001
docker build --platform linux/amd64 -t "$REPOSITORY:$IMAGE_TAG" app/backend/api
docker push "$REPOSITORY:$IMAGE_TAG"
aws ecr describe-images --repository-name "${REPOSITORY#*/}" \
  --image-ids imageTag="$IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text
```

Set `api_image_digest` to the actual returned sha256 digest in `terraform.tfvars`.
Before the first full apply, also follow the Worker ECR target apply, image push,
and digest selection steps in [worker-scaling.md](worker-scaling.md#fargate-deployment).
Set `worker_image_digest` and keep `worker_desired_count = 0`. Targeting is only
for initial repository creation. The full plan requires both image digests and
verifies their existence in ECR before creating task definitions, even at zero
desired count.

The image downloads the [AWS RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)
at build time to `/app/certs/rds-global-bundle.pem`, readable by API and migration.
Download failure fails the build. Rebuild and deploy a new digest on CA updates.

## 2. Full apply with API and Worker stopped

```bash
terraform -chdir=app/infra/terraform-compute plan -out=foundation.tfplan
terraform -chdir=app/infra/terraform-compute apply foundation.tfplan
```

Keep `api_desired_count = 0` and `worker_desired_count = 0`. This creates RDS,
networking and task definitions, but starts neither service nor migration.
Populate the application secret before
starting any task. RDS manages the administrator password. The default username
is `video_admin`; `rdsadmin` is reserved by RDS.

## 3. Create the application role through an in-VPC SSM host

Provision a temporary SSM-managed EC2 instance in one of `public_subnet_ids`, with
a public IP, `api_security_group_id`, no SSH ingress and an instance profile with
AmazonSSMManagedInstanceCore. Use an image with SSM Agent and install psql and
curl. Outbound HTTPS reaches SSM without NAT. The existing API-SG-to-DB rule lets
this host reach private RDS on 5432; do not open RDS to public CIDRs. This host is
operator-managed outside the compute state and is removed after bootstrap.

Before opening the session, verify permissions in the dedicated account:

1. Run `aws sts get-caller-identity` and confirm the expected account and operator
   role. In IAM, check that this role can start an SSM session on the temporary
   instance and the selected session document, and terminate its own sessions.
   Check applicable permission boundaries/SCPs as well as attached policies.
2. In EC2, select the temporary instance and follow its **IAM role** link. Confirm
   its instance profile contains the intended role, that its trust policy allows
   `ec2.amazonaws.com` to assume it, and that `AmazonSSMManagedInstanceCore` is
   attached. See the [AWS instance-permission verification procedure](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-instance-profile.html).
3. In Systems Manager, confirm the instance appears as a managed node with
   **Online** status. Successfully opening the session below confirms actual
   session access; merely attaching a policy does not prove connectivity.
4. In EC2 security groups, confirm the host has `api_security_group_id` and the
   RDS security group allows inbound TCP 5432 from that group. Confirm host egress
   permits DB traffic and HTTPS for SSM. No public DB ingress is required.
5. In IAM/Secrets Manager, confirm the operator has `secretsmanager:GetSecretValue`
   on the exact `rds_admin_secret_arn` and `secretsmanager:PutSecretValue` on the
   application secret. If a customer-managed KMS key is used, check the required
   key permissions and key policy too. Retrieve the administrator password only
   through the console as described below; do not print it to verify access.
   These operator permissions must not be added to the temporary host role or
   the API task role.

Run `aws ssm start-session --target <instance-id>`. An authorized operator reads
the RDS-managed secret identified by `rds_admin_secret_arn` in Secrets Manager,
and enters its password only at the psql password prompt. Do not put it in shell
arguments, Terraform, task overrides or logs. Use a session configuration that
does not record sensitive input. The host needs no permission to read the secret.
On the host:

```bash
curl --fail --silent --show-error --location \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o /tmp/rds-global-bundle.pem
# Substitute the actual RDS hostname, database and configured administrator.
PSQL_HISTORY=/dev/null psql \
  'host=<rds_endpoint> dbname=video user=video_admin sslmode=verify-full sslrootcert=/tmp/rds-global-bundle.pem' -W
```

Immediately after connecting, verify the administrator and target database:

```sql
SELECT current_user, current_database();
```

Expect `video_admin` / `video` (or the explicitly configured administrator and
database). If either differs, reconnect to the correct database before creating
the role or running any `GRANT`; schema privileges apply to the connected database.
Only after this check, create the non-admin role and set a password at the hidden
prompt:

```sql
CREATE ROLE video_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password video_app
GRANT CONNECT ON DATABASE video TO video_app;
GRANT USAGE, CREATE ON SCHEMA public TO video_app;
```

Before saving the application URL, verify the grants in the same database:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication
FROM pg_roles WHERE rolname = 'video_app';
SELECT has_database_privilege('video_app', current_database(), 'CONNECT') AS can_connect,
       has_schema_privilege('video_app', 'public', 'USAGE') AS can_use_schema,
       has_schema_privilege('video_app', 'public', 'CREATE') AS can_create_tables;
```

Expect one role row with `rolcanlogin = t` and all four administrative flags `f`,
and all three privilege results `t`. These checks use PostgreSQL's
[privilege inquiry functions](https://www.postgresql.org/docs/16/functions-info.html).
Exit with `\q` and reconnect from the same host using the application password:

```bash
PSQL_HISTORY=/dev/null psql \
  'host=<rds_endpoint> dbname=video user=video_app sslmode=verify-full sslrootcert=/tmp/rds-global-bundle.pem' -W
```

Verify real login and schema access with a transaction that leaves no test table:

```sql
\set ON_ERROR_STOP on
SELECT current_user, current_database();
BEGIN;
CREATE TABLE public.bootstrap_permission_probe (id integer PRIMARY KEY);
INSERT INTO public.bootstrap_permission_probe VALUES (1);
SELECT * FROM public.bootstrap_permission_probe;
ROLLBACK;
\q
```

`ROLLBACK` removes the table created in this transaction, so no explicit `DROP`
is needed. Expect `current_user = video_app`, the intended database, and the inserted row
without permission errors. On failure, roll back and correct the specific missing
grant or connection setting before proceeding; do not grant administrator roles.

Substitute a custom DB name if configured. Populate the existing application
secret as a **plain string** in Secrets Manager:
`postgresql://video_app:<URL-encoded-password>@<rds_endpoint>:5432/video?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem`.
Never paste the real URL into shell history, Terraform or logs. API and migration
receive only this application credential. Migration creates tables owned by
`video_app`. Terminate the temporary host. Delete its Instance Profile and IAM Role
only if they were created exclusively for this bootstrap and are no longer used
by any other instance or workload. Retain shared or pre-existing profiles and
roles; confirm each resource's usage before deleting it.

## 4. Run migration once and verify success

From repo root in the operator shell:

```bash
COMPUTE_OUTPUTS=$(terraform -chdir=app/infra/terraform-compute output -json)
CLUSTER=$(jq -r '.ecs_cluster.value' <<< "$COMPUTE_OUTPUTS")
MIGRATION=$(jq -r '.migration_task_definition.value' <<< "$COMPUTE_OUTPUTS")
NETWORK=$(jq -c '{awsvpcConfiguration:{subnets:.public_subnet_ids.value,securityGroups:[.api_security_group_id.value],assignPublicIp:"ENABLED"}}' <<< "$COMPUTE_OUTPUTS")
RUN=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$MIGRATION" --network-configuration "$NETWORK")
jq -e '(.failures | length) == 0 and (.tasks | length) == 1' <<< "$RUN" || exit 1
TASK=$(jq -r '.tasks[0].taskArn' <<< "$RUN")
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK" || exit 1
RESULT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK")
jq -e '(.failures | length) == 0 and (.tasks | length) == 1 and
  ([.tasks[0].containers[] | select(.name == "migration")] | length) == 1 and
  all(.tasks[0].containers[]; .exitCode == 0)' <<< "$RESULT" || exit 1
```

The task overrides ENTRYPOINT with `/bin/sh -ec`, applies 0001 then 0002, and
stops on the first SQL error. Inspect `/ecs/<project>-<environment>/migration`
logs and the exit code. A stopped task alone is not success. Scripts are not
idempotent: inspect and repair partial schema before retrying failed migration.

## 5. Start API and verify

Only after migration succeeds, persist `api_desired_count = 1` (or more) in
`terraform.tfvars`, review a fresh full plan and apply it. Wait for ECS stability
and healthy ALB targets. Verify HTTPS `/api/v1/health` at the certificate-covered
DNS name, schema validation, database TLS, upload presigning and CloudFront
playback. API and migration use the same verified TLS application URL.

Then start Worker with `worker_desired_count = 1` through a fresh full plan/apply,
following [worker-scaling.md](worker-scaling.md#fargate-deployment) for protection
verification and local-worker cutover.

For a small MVP budget use one db.t4g.micro, 20 GiB, one API task, seven-day logs
and no NAT Gateway. ALB, public IPv4, RDS and storage can still cost money when
API count is zero. Stop API and carefully stop RDS when idle; preserve snapshots
before removal. Operators own DNS, certificates and live acceptance.

Offline verification covers both compute and shared delivery/reliability roots:

```bash
python app/scripts/validate_terraform_contracts.py --stage workers
python app/scripts/validate_contracts.py
```

For alternate locations pass `--terraform-dir <compute-root>` and
`--shared-terraform-dir <shared-root>`. The default shared root is the sibling
`terraform` directory. Missing shared configuration fails. Static success does
not prove provider readiness or live TLS connectivity.
