terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # This is a scalability-only fallback, outside the source tree. Operators
  # should replace it with their private absolute path via backend config.
  backend "local" {
    path = "/var/lib/streaming-video-e2e/scalability/delivery/terraform.tfstate"
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
  tags = {
    Environment = "scalability-e2e"
    Disposable  = "true"
    Scope       = local.prefix
  }
}

module "foundation" {
  source              = "../../terraform"
  allowed_account_ids = [var.aws_account_id]
  resource_tags       = local.tags
  project_name        = "streaming-video"
  environment         = "scalability-e2e-${var.instance}"
  aws_region          = var.aws_region
  video_input_bucket  = "${local.prefix}-${var.aws_account_id}-${var.aws_region}-input"
  video_output_bucket = "${local.prefix}-${var.aws_account_id}-${var.aws_region}-output"
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
