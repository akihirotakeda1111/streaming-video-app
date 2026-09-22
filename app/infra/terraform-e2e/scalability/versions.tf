terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Unusable sentinel. Init must pass -backend-config with a private absolute
  # state path. Without that override Terraform cannot open a state file, so a
  # missing backend config cannot fall back to the example path or any default.
  backend "local" {
    path = "/dev/null/streaming-video-scalability-e2e-delivery.tfstate"
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
  prefix = "streaming-video-scalability-e2e-${var.instance}"
  # S3 names are limited to 63 characters. The resource prefix above exceeds
  # that once account, region, and instance are included. Buckets alone use
  # this shorter prefix. Worst case with a 12-character instance, 12-digit
  # account, and 16-character region is 62 characters for the output bucket.
  s3_bucket_prefix = "sv-scale-e2e-${var.instance}"
  tags = {
    Environment = "scalability-e2e"
    Disposable  = "true"
    Scope       = local.prefix
  }
}

check "s3_bucket_names" {
  assert {
    condition = (
      length("${local.s3_bucket_prefix}-${var.aws_account_id}-${var.aws_region}-input") <= 63
      && length("${local.s3_bucket_prefix}-${var.aws_account_id}-${var.aws_region}-output") <= 63
    )
    error_message = "Scalability S3 bucket names must be 63 characters or fewer."
  }
}

module "foundation" {
  source              = "../../terraform"
  allowed_account_ids = [var.aws_account_id]
  resource_tags       = local.tags
  project_name        = "streaming-video"
  environment         = "scalability-e2e-${var.instance}"
  aws_region          = var.aws_region
  video_input_bucket  = "${local.s3_bucket_prefix}-${var.aws_account_id}-${var.aws_region}-input"
  video_output_bucket = "${local.s3_bucket_prefix}-${var.aws_account_id}-${var.aws_region}-output"
  frontend_origin     = var.frontend_origin
  frontend_origins    = var.frontend_origins

  source_visibility_timeout_seconds   = var.source_visibility_timeout_seconds
  worker_heartbeat_interval_seconds   = var.worker_heartbeat_interval_seconds
  worker_visibility_extension_seconds = var.worker_visibility_extension_seconds
  worker_lease_duration_seconds       = var.worker_lease_duration_seconds
  worker_retry_delay_seconds          = var.worker_retry_delay_seconds
  worker_maximum_attempts             = var.worker_maximum_attempts
  queue_max_receive_count              = var.queue_max_receive_count
}
