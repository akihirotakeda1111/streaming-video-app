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
account and region, the delivery resource prefix
`streaming-video-scalability-e2e-<instance>`, the compute resource prefix
`streaming-video-scale-e2e-<instance>` (at most 32 characters), the shorter
S3-only prefix `sv-scale-e2e-<instance>`, both absolute state paths, and these
distinct absolute data directories:

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

### Prepare the operator shell

Run the commands in this runbook in Bash on WSL/Linux, from the repository
root, and stop on any failure. Use the same shell environment for Terraform,
AWS CLI, and the runner. Install AWS CLI v2, Terraform compatible with the
roots' `required_version`, Docker with a running daemon, Python 3, Node.js
(`^22.18.0 || >=24.12.0`), npm, jq, curl, and FFmpeg (including ffprobe).
Use the existing operator credentials/profile; never put credentials in the
handoff. Check the selected account against the private tfvars before proceeding:

```bash
export AWS_PROFILE=your-dedicated-e2e-profile
export AWS_REGION=ap-northeast-1
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""
aws --version
terraform version
docker version
python --version
node --version
npm --version
jq --version
curl --version
ffmpeg -version
ffprobe -version
aws sts get-caller-identity
aws configure list
umask 077
mkdir -p "$SCALABILITY_RUNTIME/delivery" "$SCALABILITY_RUNTIME/compute"
cp app/infra/terraform-e2e/scalability/backend-delivery.tfbackend.example "$SCALABILITY_RUNTIME/delivery/backend.tfbackend"
cp app/infra/terraform-e2e/scalability/backend-compute.tfbackend.example "$SCALABILITY_RUNTIME/compute/backend.tfbackend"
cp app/infra/terraform-e2e/scalability/terraform.tfvars.example "$SCALABILITY_RUNTIME/delivery/terraform.tfvars"
cp app/infra/terraform-e2e/scalability/compute.tfvars.example "$SCALABILITY_RUNTIME/compute/compute.tfvars"
```

Copy examples only for a new environment; do not overwrite an existing run's
backend or tfvars. Edit both backend `path` values to exactly `$DELIVERY_STATE`
and `$COMPUTE_STATE` (literal absolute paths, not shell variable strings), and
set compute `shared_state_path` to that same delivery state path. Retain these
files for teardown.

### API custom DNS and TLS

Choose an operator-owned API subdomain, for example `api-scale.example.com`.
Request an ACM public certificate in **the ALB's region** (`$AWS_REGION`), with
that exact hostname covered by its domain name or SAN. For DNS validation:

```bash
export API_DNS_NAME=api-scale.example.com
export API_URL="https://$API_DNS_NAME"
export CERTIFICATE_ARN=$(aws acm request-certificate --region "$AWS_REGION" \
  --domain-name "$API_DNS_NAME" --validation-method DNS \
  --query CertificateArn --output text)
aws acm describe-certificate --certificate-arn "$CERTIFICATE_ARN" \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord'
```

Create the returned validation CNAME name/value at the authoritative DNS
provider (repeat the describe command if records are not available yet).
Keep that validation record for renewal. For an existing certificate, set
`CERTIFICATE_ARN` to its ARN instead of requesting another certificate.

```bash
aws acm wait certificate-validated --certificate-arn "$CERTIFICATE_ARN"
aws acm describe-certificate --certificate-arn "$CERTIFICATE_ARN" \
  --query 'Certificate.{Status:Status,Domains:SubjectAlternativeNames}'
```

Require `ISSUED` and hostname coverage, then set `acm_certificate_arn` in the
private compute tfvars before its full apply. After the ALB is deployed,
read its generated hostname and create a **separate** application DNS record:

```bash
ALB_URL=$(TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" output -raw api_base_url)
ALB_DNS=${ALB_URL#https://}
printf '%s CNAME %s\n' "$API_DNS_NAME" "$ALB_DNS"
aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?DNSName=='$ALB_DNS'].{ARN:LoadBalancerArn,DNS:DNSName,Zone:CanonicalHostedZoneId}"
```

At the DNS provider, create the printed CNAME for the API subdomain pointing
to the ALB hostname, without `https://` or a path. With Route 53, an A Alias
to this ALB using the returned canonical hosted zone ID is also supported.
After DNS propagation and API startup, verify normal TLS hostname validation:

```bash
getent hosts "$API_DNS_NAME"
curl --fail --show-error "$API_URL/api/v1/health"
```

The compute output `api_base_url` is `https://<ALB-generated-hostname>`;
it is only used to find the DNS target. **Do not use it as handoff `api_url`
or frontend `VITE_API_BASE_URL`**: the ACM certificate covers the custom
hostname, not the generated `*.elb.amazonaws.com` hostname. Do not bypass
certificate errors with `curl -k` or disabled browser TLS checks.

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

Copy `compute.tfvars.example` to the private compute tfvars file. Keep
`environment` short enough that the compute resource prefix
`streaming-video-scale-e2e-<instance>` is at most 32 characters; the example
uses `scale-e2e-load`. Set the absolute delivery `shared_state_path`,
certificate, and database secret. Leave
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
- Delivery resource prefix `streaming-video-scalability-e2e-<instance>`
- Compute resource prefix `streaming-video-scale-e2e-<instance>` (at most 32 characters)
- S3 prefix `sv-scale-e2e-<instance>`
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

### Prepare the fixture and frontend

Use a fixture with display dimensions at least 1280x720 (or 720x1280), a
positive duration, and a small compressed upload size. The video duration is
not the Worker processing time. A short or easily encoded clip can finish
before the three-minute scale-out observation even when its resolution is
720p. Conversely, a large high-bitrate input can exceed the parallel upload
window. Start with a compressible, long, normal-frame-rate clip and calibrate
its duration/content on the deployed Worker image and task CPU/memory:

```bash
mkdir -p "$SCALABILITY_RUNTIME/fixtures"
export FIXTURE_PATH="$SCALABILITY_RUNTIME/fixtures/scalability-720p.mp4"
ffmpeg -f lavfi -i 'testsrc2=size=1280x720:rate=30' -t 150 \
  -c:v libx264 -preset fast -crf 50 -pix_fmt yuv420p -an -movflags +faststart \
  "$FIXTURE_PATH"
chmod 600 "$FIXTURE_PATH"
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,duration:format=duration,size -of json "$FIXTURE_PATH"
export FIXTURE_DURATION_SECONDS=$(ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 "$FIXTURE_PATH")
sha256sum "$FIXTURE_PATH"
```

This is a starting candidate, not a guarantee of 300 seconds of processing.
Before acceptance, measure job processing from Worker acquisition to completion
using logs and Step Functions execution times for the same image/resources.
Keep any calibration job IDs and evidence separate, clean them up, and wait
for the queue to drain and the parent service to return to one before Task 90.
Choose a fixture whose measured processing time is representative of
`worker_representative_processing_seconds = 300` and handoff
`processing_seconds = 300`. It must sustain backlog for at least the whole
submission window plus the observed scale-out evaluation (60 + 180 = 240
seconds in the example), with margin for variation. Adjust the fixture and
remeasure if it finishes too quickly; do not merely label it `300` in JSON.
If it takes substantially longer, the 300-second budget model is also invalid.
Keep duration, source size, temporary storage, and wall time within the deployed
Worker limits. Do not retune autoscaling or insert artificial Worker delays.
`--check` validates the declared timing model; ffprobe verifies media properties,
and neither measures real processing time. Check the actual batch upload time
in `submission.elapsedSeconds` after the run.

For a local frontend, use `http://localhost:5173` as `frontend_origin` in both
private delivery and compute tfvars before applying CORS configuration. Use
that exact origin in the handoff and access it from the same WSL/Linux runtime
as Playwright. Install frontend dependencies and its matching browser:

```bash
npm --prefix app/frontend ci
(cd app/frontend && npx playwright install --with-deps chromium)
export FRONTEND_URL=http://localhost:5173
VITE_API_BASE_URL="$API_URL" npm --prefix app/frontend run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Keep the frontend running in a separate terminal with the same `API_URL`.
In the runner terminal, restore the exported variables and verify:

```bash
curl --fail --show-error "$FRONTEND_URL/"
curl --fail --show-error "$API_URL/api/v1/health"
curl --fail --show-error -i -X OPTIONS "$API_URL/api/v1/videos" \
  -H "Origin: $FRONTEND_URL" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

Confirm the CORS response allows the exact frontend origin. A supplied hosted
frontend can be used instead, with its API URL and both roots' CORS origins
configured consistently. The runner does not start the frontend.

### Create the handoff JSON

#### Automated read-only setup (recommended)

After deployment, fixture calibration and frontend startup, source the setup
wrapper from WSL/Linux. It uses the runtime layout above, with the initialized
local backends and literal values in the private tfvars files:

```bash
source app/scripts/setup_scalability_env.sh \
  --runtime "$SCALABILITY_RUNTIME" \
  --account 123456789012 \
  --api-url "$API_URL" \
  --frontend-url "$FRONTEND_URL" \
  --fixture "$FIXTURE_PATH"
```

Replace the account with the expected dedicated account. Optional arguments are
`--profile NAME`, `--submission-window-seconds 60`, and
`--runtime-budget-seconds 3600`. The setup checks Node, Python, AWS CLI,
Terraform, ffmpeg and ffprobe; both private backend/state/data directories;
allowlisted Terraform outputs; STS account; Task 89 fixed tfvars; video
resolution/duration; frontend/API reachability; and exact-origin API CORS.
It calls `generate_scalability_env.mjs`'s shared discovery/generation functions
and runs `python app/scripts/run_scalability_e2e.py --check` against a temporary
handoff before publishing `handoff.json`. It never calls Terraform init/apply,
changes AWS, starts services, installs dependencies, or submits workload.
Docker/npm/jq/curl remain prerequisites for the separate deployment/manual
steps, not for this setup. Install Playwright dependencies/browser as above
before the live run.

Only successful setup exports `SCALABILITY_RUNTIME`, `SCALABILITY_E2E_CONFIG`,
`AWS_REGION`, `AWS_DEFAULT_REGION`, `SCALABILITY_E2E_EVIDENCE_ROOT` and, when
explicitly selected, `AWS_PROFILE` into the current shell. It does not enable
live execution or select/create a per-run evidence directory. Use the exported
evidence root to choose a fresh directory for each `--full` run as below.
Failure leaves the shell unchanged and suppresses child-command diagnostics
that could contain secrets. An identical existing handoff can be reused;
a different existing handoff is preserved and blocks setup. Review and move
that handoff to a retained backup before deliberately regenerating it.

For generation alone, use `node app/scripts/generate_scalability_env.mjs` with
the same arguments. This writes a new private `handoff.json` without shell
exports or network health checks and refuses to overwrite any existing file.
Neither ffprobe nor `--check` proves 300-second processing calibration or live
AWS configuration; those still require the calibration and `--full` checks.
All generated configuration stays in the private runtime, never in evidence
or source control. The scripts read only named non-secret Terraform outputs.

#### Manual alternative

After the full apply and startup, export the non-secret delivery and compute
outputs using the same initialized backend and data directories:

```bash
TF_DATA_DIR="$DELIVERY_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-e2e/scalability" output -json > "$SCALABILITY_RUNTIME/delivery/outputs.json"
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" output -json > "$SCALABILITY_RUNTIME/compute/outputs.json"
```

Terraform output JSON wraps each value in `.value`. Map fields as follows;
values without an output come from the reviewed deployment or operator inputs:

| Handoff JSON field | Source |
| --- | --- |
| `account_id` | `aws sts get-caller-identity` Account, matching delivery `aws_account_id` and compute `allowed_account_ids` |
| `region`, `environment` | Delivery `aws_region.value`, `environment_identity.value` |
| `input_bucket`, `playback_base_url` | Delivery `video_input_bucket_name.value`, `playback_base_url.value` |
| `cluster`, `api_service` | Compute `ecs_cluster.value`, `api_service.value` |
| `worker_service`, `parent_service` | Both use compute `worker_service.value`; there is no separate parent-service output |
| `step_functions_arn` | Compute `orchestration_state_machine.value` |
| `api_image_digest`, `worker_image_digest` | Corresponding compute outputs' `.value` |
| `api_url`, `frontend_url` | Verified custom HTTPS API origin, reachable frontend origin |
| `distributed_mode`, `parent_min_capacity` | `true`, `1`; verify live distributed configuration and steady parent service |
| `worker_max_concurrency` | Deployed Worker task-definition `WORKER_MAX_CONCURRENCY` (currently `1`) |
| `worker_min_capacity`, `worker_max_capacity` | Compute tfvars `worker_autoscaling_min_capacity` / `worker_autoscaling_max_capacity` (`1` / `4`) |
| `processing_seconds`, `backlog_per_worker_target` | Compute `worker_representative_processing_seconds` (`300`), and `worker_acceptable_queue_delay_seconds / worker_representative_processing_seconds` (`900 / 300 = 3`) |
| `scale_out_cooldown_seconds`, `scale_in_cooldown_seconds` | Compute `worker_scale_out_cooldown_seconds` / `worker_scale_in_cooldown_seconds` (`180` / `600`) |
| `fixture_path`, `fixture_duration_seconds` | Operator-only absolute file path and ffprobe duration above |
| `submission_window_seconds`, `runtime_budget_seconds` | Operator timing/cost budget; example `60`, `3600`, subject to `--check` and live alarm periods |

The JSON `environment` is **`scalability-e2e-<instance>`**, from delivery.
The compute tfvars `environment` is **`scale-e2e-<instance>`**, shortened for
ALB name limits. Do not substitute the compute name in the JSON or reconstruct
service names from the delivery identity. With instance `load`, these are
`scalability-e2e-load` and `scale-e2e-load`, respectively.

Create the complete runner handoff (the fixed numbers below must match the
reviewed deployed settings and fixture calibration):

```bash
export SCALABILITY_E2E_CONFIG="$SCALABILITY_RUNTIME/handoff.json"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
jq -n --slurpfile d "$SCALABILITY_RUNTIME/delivery/outputs.json" \
  --slurpfile c "$SCALABILITY_RUNTIME/compute/outputs.json" \
  --arg account "$ACCOUNT_ID" --arg api "$API_URL" --arg frontend "$FRONTEND_URL" \
  --arg fixture "$FIXTURE_PATH" --argjson duration "$FIXTURE_DURATION_SECONDS" '
  ($d[0] | with_entries(.value = .value.value)) as $d |
  ($c[0] | with_entries(.value = .value.value)) as $c |
  {
    account_id: $account, region: $d.aws_region, environment: $d.environment_identity,
    api_url: $api, frontend_url: $frontend, playback_base_url: $d.playback_base_url,
    cluster: $c.ecs_cluster, api_service: $c.api_service,
    worker_service: $c.worker_service, parent_service: $c.worker_service,
    input_bucket: $d.video_input_bucket_name,
    step_functions_arn: $c.orchestration_state_machine,
    api_image_digest: $c.api_image_digest, worker_image_digest: $c.worker_image_digest,
    distributed_mode: true, parent_min_capacity: 1, worker_max_concurrency: 1,
    fixture_path: $fixture, fixture_duration_seconds: $duration,
    worker_min_capacity: 1, worker_max_capacity: 4, backlog_per_worker_target: 3,
    processing_seconds: 300, submission_window_seconds: 60,
    scale_out_cooldown_seconds: 180, scale_in_cooldown_seconds: 600,
    runtime_budget_seconds: 3600
  }' > "$SCALABILITY_E2E_CONFIG"
chmod 600 "$SCALABILITY_E2E_CONFIG"
python app/scripts/run_scalability_e2e.py --check
```

Keep the output files alongside the handoff for bucket ARNs, output bucket,
queue, distribution, and task-definition identifiers used in investigation and
cleanup. They are not extra required runner fields. Do not copy private state,
credentials, database secrets, or the fixture path into published evidence.

## Task 90 integrated validation

Task 90 consumes a non-secret JSON handoff from the deployed environment; it
does not apply Terraform, update ECS services, change database mode, or create
resources. Set `SCALABILITY_E2E_CONFIG` to that handoff and use the following
offline gate before any live work:

```bash
python app/scripts/run_scalability_e2e.py --check
```

The handoff records `account_id`, `region`, the environment identity, API and
frontend origins, CloudFront playback origin, cluster, `api_service`,
`worker_service`, and `parent_service`, the dedicated `input_bucket` name,
Step Functions ARN, `distributed_mode: true`, `parent_min_capacity: 1`,
`worker_max_concurrency`, `submission_window_seconds`, API/Worker image digests,
the 720p-or-higher fixture path and duration, worker limits, backlog-per-worker
target, representative processing time, cooldowns, and the total runtime budget.
`api_service` is the
ECS API service name from the compute outputs. `input_bucket` is that
environment's video input bucket name. `worker_max_concurrency` is the deployed
`WORKER_MAX_CONCURRENCY`. Live `--full` resolves `fixture_path` once to an
absolute path and passes that same path to ffprobe and Playwright. On WSL or
Linux that path must be a Linux absolute path, such as `/mnt/c/...`, not a
Windows drive path. The fixture path is never copied into evidence and must be
readable only by the operator running the test.

The runner derives and records one fixed batch before submission. The scaling
metric is visible queue depth divided by running workers, and visible depth
does not include messages the initial workers have already received. The batch
is `floor(backlog_per_worker_target * worker_min_capacity) + 1 + worker_min_capacity * worker_max_concurrency`.
After those workers take `worker_max_concurrency` messages each, the remaining
visible backlog per running worker stays strictly above the target. For target
3, minimum 1, and concurrency 1, the batch is 5: one message is in flight and
four remain visible, so the ratio is 4. A batch of 4 would leave a ratio of 3
and would not hold the scale-out condition across the evaluation periods.

That predetermined batch is uploaded in parallel. `submission_window_seconds`
is the planned upper bound for the whole parallel upload. Representative
processing time must be at least that window plus the scale-out evaluation,
because the first object can start processing while later uploads in the same
batch are still finishing. The runtime budget includes the submission window,
drain on at least two workers, both cooldowns, the scale-in evaluation window,
and playback. If the measured batch submission time exceeds the planned window,
the run fails. Offline `--check` uses the target-tracking defaults of 3
one-minute periods to scale out and 15 one-minute periods to scale in. A budget
that cannot cover that plan is rejected before any job is submitted. The
rationale and fixture identity are written to `planned-workload.json`. The
fixture record is the file name, measured duration when ffprobe supplied one,
size, and SHA-256 only. No later submission is permitted.

API and CloudFront URLs in the handoff must be `https`. The frontend URL may be
`https`, or `http` on `localhost`, `127.0.0.1`, or `::1`. `--check` makes no
AWS calls. A live run additionally requires `SCALABILITY_E2E_ALLOW_LIVE=true`
and an explicit dedicated-environment handoff:

```bash
SCALABILITY_E2E_ALLOW_LIVE=true \
python app/scripts/run_scalability_e2e.py --full
```

Live preflight probes the fixture with ffprobe before AWS submission. The file
must contain a video stream whose display dimensions are at least 1280×720 in
either orientation, and a positive duration. A smaller stream, a missing video
stream, or unavailable ffprobe stops `--full` before jobs are created. Evidence
uses that measured duration. The runner then reads AWS. The handoff's own
account, target,
cooldowns, image digests, and `distributed_mode` flag are not sufficient. The
runner compares the caller account, requires the parent service to be steady at
one running and desired task, and checks the worker image digest,
`WORKER_MAX_CONCURRENCY`, `VIDEO_INPUT_BUCKET`, and
`ORCHESTRATION_STATE_MACHINE_ARN` on that task definition. It requires the
named API service to be active with at least one running and desired task, the
API image digest on that service's task definition, and the same dedicated
input bucket. It then requests `GET /api/v1/health` on the API origin and the
frontend URL, and confirms the input bucket exists in the handoff region. A
presigned upload whose bucket is not that input bucket is rejected before the
fixture is sent. It also requires an active state machine whose definition is
the distributed 360p/720p `runTask.sync` workflow, an autoscaling target and
target-tracking policy whose metric is visible queue depth divided by running
workers, and the alarms referenced by that policy. Metric-math alarms carry
their sampling period on each `MetricStat`; the evaluation window is that
period multiplied by `EvaluationPeriods`. The scale-out alarm uses a
`GreaterThan` comparison. The scale-in alarm uses a `LessThan` comparison and
its threshold is at or below the backlog-per-worker target, because target
tracking can scale in only after the metric falls below the target. Observed
alarm periods replace the offline evaluation defaults, and the batch plan is
checked again against those periods. `preflight.json` records the non-secret
observation.

The runtime budget deadline is fixed before submission starts. Scale-out
sampling, job completion, playback, and scale-in all use that same instant.
Playback waits no longer than the playback timeout or the time remaining until
the deadline, whichever is shorter. The Playwright project timeout is the
runtime budget plus two minutes so evidence can still be written after the
deadline. Other Playwright
projects keep their existing timeout. The live project is explicitly selected
as `scalability`; ordinary `npm --prefix app/frontend run test:e2e` and the
Reliability runner do not discover its scenarios.

The scenario uploads the predetermined batch in parallel, then measures all of
the following from the same jobs. A video created by `POST /videos` is recorded
immediately. If the presigned upload then fails, that job stays in the evidence
as `SUBMISSION_FAILED` with its video ID, job ID, and error so cleanup can see
every run-owned job. Each checkpoint is `PASS`, `FAIL`, or `NOT RUN`. Overall
status is `passed` only when every checkpoint is `PASS` and the measured
submission time is within `submission_window_seconds`:

- parent service running tasks move from 1 to at least 2
- different parent tasks process different job IDs over overlapping log intervals
- at least one job has distinct 360p and 720p child task ARNs whose Step Functions and ECS intervals overlap
- every submitted job reaches API `COMPLETED`
- after that completion, the parent service returns to its configured minimum
- the completed output plays through the installed video.js player on the frontend origin, including master, 360p, and 720p playlist and segment requests, decoded `readyState`, advancing `currentTime`, and a rendition switch selected by the `360p` or `720p` playlist or representation path. The switch is confirmed only after a `.ts`, `.m4s`, or `.mp4` media segment for that rendition is requested

`workload.json` is updated while observations progress. Those intermediate
writes are best-effort, keep `finalized: false`, and never record overall
status `passed`, even when every checkpoint is already `PASS`. Only the write
after observation stops can set `finalized: true` and status `passed`. That
write is required: if it fails, the run is failed even when every checkpoint
passed. If the process then exits non-zero and a `passed` artifact is still
present, the runner records that artifact as failed instead of leaving it as
acceptance. A timeout, a failed job, or a failed preflight still leaves the
incomplete jobs, task samples, and execution intervals that were collected.
Missing observations stay `NOT RUN` or `FAIL`; they are not treated as success.
A failed or timed-out job is not a partial acceptance. Operators retain cleanup
ownership and must leave unresolved workload status recorded before environment
teardown.

### Run, inspect acceptance, and rerun

Use a new, absolute evidence directory for **every** run, including a retry
after preflight failure. The runner creates the final directory itself with
`exist_ok=False`; do not pre-create it or reuse/delete a previous run's evidence.
Recheck the account, region, handoff, fixture calibration, frontend health,
empty workload queue, and steady parent minimum before submitting another batch.

```bash
export SCALABILITY_E2E_CONFIG="$SCALABILITY_RUNTIME/handoff.json"
export AWS_REGION=$(jq -r .region "$SCALABILITY_E2E_CONFIG")
export AWS_DEFAULT_REGION="$AWS_REGION"
python app/scripts/run_scalability_e2e.py --check
mkdir -p "$SCALABILITY_RUNTIME/evidence"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(python -c 'import uuid; print(uuid.uuid4().hex)')"
export SCALABILITY_E2E_EVIDENCE_DIR="$SCALABILITY_RUNTIME/evidence/$RUN_ID"
if SCALABILITY_E2E_ALLOW_LIVE=true python app/scripts/run_scalability_e2e.py --full; then
  RUN_EXIT=0
else
  RUN_EXIT=$?
fi
printf '%s\n' "$RUN_EXIT" > "$SCALABILITY_E2E_EVIDENCE_DIR/runner-exit-code.txt"
jq '{finalized,status,submission,checkpoints,incompleteJobIds,error}' \
  "$SCALABILITY_E2E_EVIDENCE_DIR/workload.json"
test "$RUN_EXIT" -eq 0
```

For the actual acceptance assertion, use the workload file and require the
recorded batch to be complete:

```bash
jq -e '
  .finalized == true and .status == "passed" and .submission.withinWindow == true
  and ([.checkpoints.parentScaleOut, .checkpoints.parentJobConcurrency,
        .checkpoints.childExecutionOverlap, .checkpoints.allJobsCompleted,
        .checkpoints.scaleIn, .checkpoints.abrPlayback] | all(.status == "PASS"))
  and (.jobs | length > 0) and (.jobs | all(.status == "COMPLETED"))
  and ((.jobs | length) == .batchSize)
' "$SCALABILITY_E2E_EVIDENCE_DIR/workload.json"
```

Acceptance requires both a zero runner exit code and this assertion. Missing
`workload.json`, `finalized=false`, any missing/FAIL/NOT RUN checkpoint, or
`submission.withinWindow` other than `true` is not acceptance. Inspect
`preflight.json`, `planned-workload.json`, and each checkpoint's reason before
rerunning. Resolve the failed run's jobs first; never add jobs to its existing
batch or overwrite its evidence to obtain a pass.

## Cleanup and destroy

### Identify and clean only run-owned jobs

Preserve all run evidence, including failed and timed-out runs. Select the
specific run to clean; do not assume the latest directory is the failed one.
The example below uses the current `SCALABILITY_E2E_EVIDENCE_DIR`:

```bash
export CLEANUP_EVIDENCE="$SCALABILITY_E2E_EVIDENCE_DIR"
jq -r '.jobs[] | [.videoId, .jobId, .status] | @tsv' \
  "$CLEANUP_EVIDENCE/workload.json"
export INPUT_BUCKET=$(jq -r .input_bucket "$SCALABILITY_E2E_CONFIG")
export OUTPUT_BUCKET=$(jq -r '.video_output_bucket_name.value' "$SCALABILITY_RUNTIME/delivery/outputs.json")
export QUEUE_URL=$(jq -r '.video_encoding_queue_url.value' "$SCALABILITY_RUNTIME/delivery/outputs.json")
export CLUSTER=$(jq -r .cluster "$SCALABILITY_E2E_CONFIG")
export PARENT_SERVICE=$(jq -r .parent_service "$SCALABILITY_E2E_CONFIG")
aws sts get-caller-identity
aws ecs describe-services --cluster "$CLUSTER" --services "$PARENT_SERVICE" \
  --query 'services[].{Service:serviceName,Desired:desiredCount,Running:runningCount,Pending:pendingCount}'
aws sqs get-queue-attributes --queue-url "$QUEUE_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed
aws stepfunctions list-executions \
  --state-machine-arn "$(jq -r .step_functions_arn "$SCALABILITY_E2E_CONFIG")" --status-filter RUNNING
```

For each pair, check `GET /api/v1/videos/{videoId}` and the execution/log records
for that `jobId` and all its attempts. `SUBMISSION_FAILED` still owns the
recorded pair even if no source object exists. A runner timeout does not stop
AWS work. Before object deletion, require the job to be terminal and no active
parent/child execution or queued retry able to write that prefix. For an
unresolved run, record its last status and drain it, or use the dedicated
environment shutdown below and verify all executions/tasks have stopped.
Do not purge SQS, delete arbitrary receipt handles, delete database rows, or
stop other runs' tasks as a shortcut. There is no application DELETE endpoint;
retain database records for investigation, or remove the dedicated database
through teardown after preserving the required snapshot.

Copy one reviewed pair from the evidence, then verify exact ownership and
preview its objects before deleting. Repeat for every pair, including failed
submissions, and for every retained run when retiring the environment:

```bash
export VIDEO_ID=replace-with-recorded-videoId
export JOB_ID=replace-with-recorded-jobId
jq -e --arg v "$VIDEO_ID" --arg j "$JOB_ID" '
  any(.jobs[]; .videoId == $v and .jobId == $j)
  and ($v | test("^[0-9a-fA-F-]{36}$")) and ($j | test("^[0-9a-fA-F-]{36}$"))
' "$CLEANUP_EVIDENCE/workload.json"
curl --fail --show-error "$API_URL/api/v1/videos/$VIDEO_ID"
JOB_PREFIX="videos/$VIDEO_ID/jobs/$JOB_ID/"
aws s3 ls "s3://$INPUT_BUCKET/$JOB_PREFIX" --recursive
aws s3 ls "s3://$OUTPUT_BUCKET/$JOB_PREFIX" --recursive
aws s3 rm "s3://$INPUT_BUCKET/$JOB_PREFIX" --recursive --dryrun
aws s3 rm "s3://$OUTPUT_BUCKET/$JOB_PREFIX" --recursive --dryrun
```

After reviewing those exact prefixes and satisfying the no-writers condition:

```bash
aws s3 rm "s3://$INPUT_BUCKET/$JOB_PREFIX" --recursive
aws s3 rm "s3://$OUTPUT_BUCKET/$JOB_PREFIX" --recursive
aws s3 ls "s3://$INPUT_BUCKET/$JOB_PREFIX" --recursive
aws s3 ls "s3://$OUTPUT_BUCKET/$JOB_PREFIX" --recursive
```

Keep the bucket and prefix non-empty and scoped to that pair; never replace
them with a bucket-wide deletion. Do not delete evidence when objects are
removed. If the run failed before evidence could record IDs, reconcile API,
Worker logs, and execution inputs first; do not infer ownership from time alone.

### Shut down and destroy compute, then delivery

Before teardown, stop submissions and retain evidence/logs outside Terraform
resources. Verify the same account/region, absolute state paths, backend files,
and dedicated data directories used at deployment. Reinitialize only with
those existing backend files, never a default or newly copied backend:

```bash
aws sts get-caller-identity
printf '%s\n' "$AWS_REGION" "$DELIVERY_STATE" "$COMPUTE_STATE" "$DELIVERY_DATA_DIR" "$COMPUTE_DATA_DIR"
cat "$SCALABILITY_RUNTIME/delivery/backend.tfbackend" "$SCALABILITY_RUNTIME/compute/backend.tfbackend"
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" init \
  -backend-config="$SCALABILITY_RUNTIME/compute/backend.tfbackend" -lockfile=readonly -reconfigure
TF_DATA_DIR="$DELIVERY_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-e2e/scalability" init \
  -backend-config="$SCALABILITY_RUNTIME/delivery/backend.tfbackend" -reconfigure
```

Set `worker_autoscaling_enabled = false`, `api_desired_count = 0`, and
`worker_desired_count = 0` in the **same private compute tfvars**. Review/apply
a full shutdown plan so autoscaling cannot restart the parents:

```bash
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" plan \
  -var-file="$SCALABILITY_RUNTIME/compute/compute.tfvars" -out="$SCALABILITY_RUNTIME/compute/shutdown.tfplan"
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" apply \
  "$SCALABILITY_RUNTIME/compute/shutdown.tfplan"
aws ecs update-service --cluster "$CLUSTER" --service "$PARENT_SERVICE" \
  --desired-count 0 --query 'service.{Service:serviceName,Desired:desiredCount}'
aws ecs wait services-stable --cluster "$CLUSTER" --services "$PARENT_SERVICE"
aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING
aws stepfunctions list-executions \
  --state-machine-arn "$(jq -r .step_functions_arn "$SCALABILITY_E2E_CONFIG")" --status-filter RUNNING
```

The Worker service has `ignore_changes = [desired_count]`, so changing its
tfvars alone does not stop an existing service. The explicit `update-service`
above is an operator teardown action, after autoscaling is disabled.
Service shutdown does not by itself stop standalone child tasks or executions.
Wait for them to finish; if cancellation is required, match execution input
`job_id`/`video_id` and task ARNs to the retained run evidence before using
`aws stepfunctions stop-execution --execution-arn <verified-arn>` and, for any
remaining child, `aws ecs stop-task --cluster "$CLUSTER" --task <verified-arn>`.
Recheck until no writers remain and record unresolved job status before
cleanup. Inspect the compute destroy plan, including the RDS final snapshot
and ECR image deletion behavior. The existing RDS configuration requires
`<compute-resource-prefix>-final`; resolve an existing snapshot-name collision
through the snapshot ownership procedure, without disabling the final snapshot.

```bash
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" plan -destroy \
  -var-file="$SCALABILITY_RUNTIME/compute/compute.tfvars" -out="$SCALABILITY_RUNTIME/compute/destroy.tfplan"
```

The ECR repositories do not enable force deletion. After saving/reviewing the
destroy plan and stopping every task, inventory both dedicated repositories.
Preserve any required images elsewhere before removing them. Use only names
from the saved compute outputs:

```bash
for OUTPUT_NAME in api_repository_url worker_repository_url; do
  REPOSITORY_URL=$(jq -r --arg name "$OUTPUT_NAME" '.[$name].value' "$SCALABILITY_RUNTIME/compute/outputs.json")
  aws ecr list-images --repository-name "${REPOSITORY_URL#*/}" \
    --query imageIds --output json
done
```

For each reviewed repository/digest pair, remove that image explicitly (repeat
for all retained build tags/digests, including any untagged image manifests):

```bash
REVIEWED_REPOSITORY=replace-with-reviewed-dedicated-repository-name
REVIEWED_DIGEST=replace-with-reviewed-sha256-digest
aws ecr batch-delete-image --repository-name "$REVIEWED_REPOSITORY" \
  --image-ids "imageDigest=$REVIEWED_DIGEST"
```

Replace the placeholder values before executing. Inspect `failures`
in each response and repeat `list-images` until both repositories are empty.
Apply the already reviewed destroy plan:

```bash
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" apply \
  "$SCALABILITY_RUNTIME/compute/destroy.tfplan"
TF_DATA_DIR="$COMPUTE_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-compute" state list
```

Require successful compute destruction and no managed compute resources
remaining (data-source entries are not deployed resources). Finish the
ID-scoped object cleanup above, using the saved delivery outputs; API health
and status checks must already have been captured before API shutdown.
Check both buckets are empty. If versioning was enabled externally, inspect
`aws s3api list-object-versions` and remove only reviewed versions/delete markers
for the recorded job prefixes as well. Unattributed objects block bucket
removal until ownership is resolved; do not enable force-destroy to bypass it.
Then review/apply the delivery destroy plan:

```bash
aws s3 ls "s3://$INPUT_BUCKET/" --recursive
aws s3 ls "s3://$OUTPUT_BUCKET/" --recursive
TF_DATA_DIR="$DELIVERY_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-e2e/scalability" plan -destroy \
  -var-file="$SCALABILITY_RUNTIME/delivery/terraform.tfvars" -out="$SCALABILITY_RUNTIME/delivery/destroy.tfplan"
TF_DATA_DIR="$DELIVERY_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-e2e/scalability" apply \
  "$SCALABILITY_RUNTIME/delivery/destroy.tfplan"
TF_DATA_DIR="$DELIVERY_DATA_DIR" terraform -chdir="$REPO_ROOT/app/infra/terraform-e2e/scalability" state list
```

Require no managed delivery resources remaining. If either destroy fails,
retain its backend/state/data directory, resolve that failure, and replan
against the same files; do not proceed to delivery while compute remains.
Remove the run-owned API DNS record after retiring the ALB. Handle ACM
certificates, validation records, database secrets, and retained RDS snapshots
through their ownership procedures; Terraform does not necessarily own them.
Keep the private state and evidence for the required retention period and stop
the local frontend when no further checks need it.
