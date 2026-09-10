terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # This root owns its state. Never use the ordinary deployment's state here.
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]
  default_tags {
    tags = local.tags
  }
}

locals {
  timing_profiles = {
    standard  = { heartbeat = 30, visibility = 120, lease = 300 }
    lifecycle = { heartbeat = 5, visibility = 30, lease = 30 }
  }
  timing = local.timing_profiles[var.timing_profile]

  prefix = "streaming-video-e2e-${var.instance}"
  tags = {
    Environment = "e2e"
    Disposable  = "true"
    Scope       = local.prefix
  }
}

# Reuse existing S3/SQS/notification/alarms and API/Worker IAM definitions.
# The child has its own provider configuration, so explicitly guard that too.
module "foundation" {
  source              = "../terraform"
  allowed_account_ids = [var.aws_account_id]
  resource_tags       = local.tags
  project_name        = "streaming-video"
  environment         = "e2e-${var.instance}"
  aws_region          = var.aws_region
  video_input_bucket  = "${local.prefix}-${var.aws_account_id}-${var.aws_region}-input"
  video_output_bucket = "${local.prefix}-${var.aws_account_id}-${var.aws_region}-output"
  frontend_origin     = var.frontend_origin

  source_visibility_timeout_seconds   = local.timing.visibility
  worker_heartbeat_interval_seconds   = local.timing.heartbeat
  worker_visibility_extension_seconds = local.timing.visibility
  worker_lease_duration_seconds       = local.timing.lease
  worker_retry_delay_seconds          = 900
  worker_maximum_attempts             = 5
  queue_max_receive_count             = 5
}

data "aws_iam_policy_document" "runner" {
  statement {
    sid       = "InspectDedicatedBuckets"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetBucketNotification"]
    resources = ["arn:aws:s3:::${module.foundation.video_input_bucket_name}", "arn:aws:s3:::${module.foundation.video_output_bucket_name}"]
  }
  statement {
    sid       = "ManageRunSources"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${module.foundation.video_input_bucket_name}/videos/*/jobs/*/source.mp4"]
  }
  statement {
    sid       = "InspectAndCleanRunOutput"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${module.foundation.video_output_bucket_name}/videos/*/jobs/*/hls/*"]
  }
  statement {
    sid       = "InspectQueues"
    actions   = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
    resources = ["arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.prefix}-encoding", "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.prefix}-encoding-dlq"]
  }
  statement {
    sid       = "InjectSourceDuplicate"
    actions   = ["sqs:SendMessage"]
    resources = ["arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.prefix}-encoding"]
  }
  # The generator lists alarms and the existing preflight describes them.
  statement {
    sid       = "DiscoverAlarms"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "runner" {
  name        = "${local.prefix}-e2e-runner"
  description = "Manual reliability E2E execution against this dedicated environment only."
  policy      = data.aws_iam_policy_document.runner.json
}
