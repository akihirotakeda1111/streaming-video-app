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
`streaming-video-scalability-e2e-<instance>`, both absolute state paths, and
these distinct absolute data directories:

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

Required operator inputs are a dedicated account, region, frontend origin,
ACM certificate ARN, DNS name for the API, application database secret ARN,
and immutable API and Worker image digests. Use the existing operator identity
and observation permissions. Do not print secret values or include them in
Terraform output.

## Deployment order

From the repository root, copy
`terraform.tfvars.example` to a private file and set the account, region,
instance, and frontend origin. Initialize and deploy delivery with its explicit
state and data paths:

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
distribution ID. Copy `compute.tfvars.example` to the private compute tfvars
file and set both image digests and the absolute delivery `shared_state_path`.
The compute root remains read-only source configuration:

```bash
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" init \
  -backend-config="$SCALABILITY_RUNTIME/compute/backend.tfbackend" \
  -reconfigure
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" plan \
  -var-file="$SCALABILITY_RUNTIME/compute/compute.tfvars" -out="$SCALABILITY_RUNTIME/compute/compute.tfplan"
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" apply \
  "$SCALABILITY_RUNTIME/compute/compute.tfplan"
```

Use the existing bootstrap and migration procedure from
[cloud-runtime.md](cloud-runtime.md), including migration `0003`. Start the
API only after migration succeeds, then enable the Worker with min `1` and max
`4`. The existing orchestration contract remains at most two children per
parent. Record API and CloudFront URLs, ECS cluster/API/Worker and migration
task-definition identifiers, Step Functions state-machine ARN, image digests,
and scaling bounds for Task 90 read-only observation.

Use bounded workload size, duration, and cost budgets. Stop API and Worker
services when the run is complete, then remove the compute deployment before
the delivery deployment. Preserve any required snapshots and follow the
existing secret/DNS/certificate ownership procedures. Never apply or destroy
from the E2E runner; Task 90 consumes the recorded outputs and observes the
environment only. CLI/distributed switching, fault injection, and frontend
hosting are outside this deployment.
