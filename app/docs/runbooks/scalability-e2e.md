# Scalability E2E deployment

This runbook deploys a fresh, distributed-enabled environment after Task 24.
It uses only `app/infra/terraform-e2e/scalability/` for E2E configuration and
leaves the Reliability E2E root and ordinary roots untouched. The operator
supplies a reachable frontend origin; frontend hosting is not provisioned here.

## Isolation and prerequisites

Choose a private runtime directory outside the repository, for example
`/var/lib/streaming-video-e2e/scalability`, and create separate `delivery` and
`compute` subdirectories. Keep the same paths for the lifetime of this
environment. Copy the two `*.tfbackend.example` files there and replace their
absolute local state paths. State, plans, `.terraform` metadata, provider data,
and credentials must remain in that private directory.

Before any live operation, verify `aws sts get-caller-identity`, the expected
account and region, the resource prefix
`streaming-video-scalability-e2e-<instance>`, the shorter S3-only prefix
`sv-scale-e2e-<instance>`, both absolute state paths, and these distinct
absolute data directories:

```bash
export SCALABILITY_RUNTIME=/var/lib/streaming-video-e2e/scalability
export DELIVERY_DATA_DIR="$SCALABILITY_RUNTIME/delivery/tf-data"
export COMPUTE_DATA_DIR="$SCALABILITY_RUNTIME/compute/tf-data"
export DELIVERY_STATE="$SCALABILITY_RUNTIME/delivery/terraform.tfstate"
export COMPUTE_STATE="$SCALABILITY_RUNTIME/compute/terraform.tfstate"
export REPO_ROOT="$(pwd)"
```

Do not use a default `.terraform` directory, an ordinary/production or
Reliability state, or a workspace as a substitute for these identities.
`app/infra/terraform-e2e/scalability/versions.tf` sets the delivery backend
path to the unusable sentinel
`/dev/null/streaming-video-scalability-e2e-delivery.tfstate`. Every delivery
`terraform init` must pass `-backend-config`. Omitting it cannot open the
example state path or any other writable default.

`app/infra/terraform-compute/.terraform.lock.hcl` is committed. Every compute
`terraform init` must pass `-lockfile=readonly` and must not pass `-upgrade`.
Initialization uses the dedicated `TF_DATA_DIR` and must not rewrite that
lockfile or any other file in the compute root.

Required operator inputs are a dedicated account, region, frontend origin,
ACM certificate ARN, DNS name for the API, and application database secret ARN.
API and Worker image digests are produced by the ECR bootstrap below; leave
them unset until those images are pushed. Use the existing operator identity
and observation permissions. Do not print secret values or include them in
Terraform output.

## Deployment order

From the repository root, copy `terraform.tfvars.example` to a private file
and set the account, region, instance, and frontend origin. Initialize and
deploy delivery with its explicit state and data paths:

```bash
TF_DATA_DIR="$DELIVERY_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-e2e/scalability" init \
  -backend-config="$SCALABILITY_RUNTIME/delivery/backend.tfbackend" \
  -reconfigure
TF_DATA_DIR="$DELIVERY_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-e2e/scalability" plan \
  -var-file="$SCALABILITY_RUNTIME/delivery/terraform.tfvars" -out="$SCALABILITY_RUNTIME/delivery/delivery.tfplan"
TF_DATA_DIR="$DELIVERY_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-e2e/scalability" apply \
  "$SCALABILITY_RUNTIME/delivery/delivery.tfplan"
```

Verify delivery outputs are non-secret and record the environment identity,
input/output bucket names and ARNs, queue URL/ARN, CloudFront domain and
distribution ID. Confirm both bucket names are at most 63 characters and use
the `sv-scale-e2e-<instance>` prefix.

Copy `compute.tfvars.example` to the private compute tfvars file. Set the
absolute delivery `shared_state_path`, certificate, and database secret. Leave
`api_image_digest` and `worker_image_digest` unset. Keep
`api_desired_count = 0`, `worker_desired_count = 0`, and
`worker_autoscaling_enabled = false`. Initialize the unchanged compute root
with the same dedicated state and data directory used for every later compute
command:

```bash
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" init \
  -backend-config="$SCALABILITY_RUNTIME/compute/backend.tfbackend" \
  -lockfile=readonly \
  -reconfigure
```

### ECR bootstrap before the full plan

Create the API and Worker repositories before the full plan. The full plan
requires both image digests and rejects an unset digest. Use the same
`TF_DATA_DIR`, backend config, and private tfvars. Targeting is only for this
initial repository creation:

```bash
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" plan \
  -var-file="$SCALABILITY_RUNTIME/compute/compute.tfvars" \
  -target=aws_ecr_repository.api \
  -target=aws_ecr_repository.worker \
  -out="$SCALABILITY_RUNTIME/compute/ecr-bootstrap.tfplan"
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" apply \
  "$SCALABILITY_RUNTIME/compute/ecr-bootstrap.tfplan"
REPOSITORY=$(TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" output -raw api_repository_url)
WORKER_REPOSITORY=$(TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" output -raw worker_repository_url)
REGISTRY=${REPOSITORY%%/*}
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
IMAGE_TAG=scalability-api-001
WORKER_IMAGE_TAG=scalability-worker-001
docker build --platform linux/amd64 -t "$REPOSITORY:$IMAGE_TAG" app/backend/api
docker push "$REPOSITORY:$IMAGE_TAG"
docker build --platform linux/amd64 -f app/backend/worker/Dockerfile -t "$WORKER_REPOSITORY:$WORKER_IMAGE_TAG" app/backend/worker
docker push "$WORKER_REPOSITORY:$WORKER_IMAGE_TAG"
aws ecr describe-images --repository-name "${REPOSITORY#*/}" \
  --image-ids imageTag="$IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text
aws ecr describe-images --repository-name "${WORKER_REPOSITORY#*/}" \
  --image-ids imageTag="$WORKER_IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text
```

Write both returned `sha256:` values into the private compute tfvars as
`api_image_digest` and `worker_image_digest`. Choose a new tag for every
rebuild; tags are immutable. Then review and apply the full plan with the same
state and data directory:

```bash
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" plan \
  -var-file="$SCALABILITY_RUNTIME/compute/compute.tfvars" -out="$SCALABILITY_RUNTIME/compute/compute.tfplan"
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" apply \
  "$SCALABILITY_RUNTIME/compute/compute.tfplan"
```

Use the existing bootstrap and migration procedure from
[cloud-runtime.md](cloud-runtime.md), including migration `0003`, with these
same `TF_DATA_DIR` and backend settings. Start the API only after migration
succeeds. Then set `worker_autoscaling_enabled = true` and apply a fresh full
plan. Keep the bounds and target inputs below; do not retune them for this
environment.

Use bounded workload size, duration, and cost budgets. Stop API and Worker
services when the run is complete, then remove the compute deployment before
the delivery deployment. Preserve any required snapshots and follow the
existing secret/DNS/certificate ownership procedures. Never apply or destroy
from the E2E runner; Task 90 consumes the recorded outputs and observes the
environment only. CLI/distributed switching, fault injection, and frontend
hosting are outside this deployment.

## Task 90 handoff

Record these non-secret values after the full apply. Task 90 reads them and
does not change autoscaling, services, or Terraform:

- Account, region, and environment identity `scalability-e2e-<instance>`
- Resource prefix `streaming-video-scalability-e2e-<instance>` and S3 prefix `sv-scale-e2e-<instance>`
- Input and output bucket names and ARNs, queue URL and ARN, CloudFront domain, distribution ID, and playback base URL
- API base URL and CloudFront URL
- ECS cluster, API service, Worker service, API, Worker, and migration task-definition identifiers
- Step Functions state-machine ARN
- API and Worker image digests
- `worker_autoscaling_min_capacity = 1` and `worker_autoscaling_max_capacity = 4`
- `worker_acceptable_queue_delay_seconds = 900`
- `worker_representative_processing_seconds = 300`
- Backlog-per-worker target `900 / 300 = 3` messages per worker, from visible SQS backlog divided by running worker tasks
- `worker_scale_out_cooldown_seconds = 180`
- `worker_scale_in_cooldown_seconds = 600`

The parent orchestration contract remains at most two children per parent.
