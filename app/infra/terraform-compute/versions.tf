terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "local" { path = "terraform.tfstate" }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = var.allowed_account_ids
  default_tags { tags = var.resource_tags }
}

data "aws_caller_identity" "current" {}
data "terraform_remote_state" "shared" {
  backend = "local"
  config  = { path = var.shared_state_path }
}

locals {
  name = "${var.project_name}-${var.environment}"
  shared = data.terraform_remote_state.shared.outputs
  api_image = "${aws_ecr_repository.api.repository_url}@${data.aws_ecr_image.api.image_digest}"
  api_env = [
    { name = "HTTP_ADDR", value = "0.0.0.0:8080" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "VIDEO_INPUT_BUCKET", value = local.shared.video_input_bucket_name },
    { name = "VIDEO_OUTPUT_BUCKET", value = local.shared.video_output_bucket_name },
    { name = "OUTPUT_S3_ENDPOINT", value = "https://s3.${var.aws_region}.amazonaws.com" },
    { name = "PLAYBACK_BASE_URL", value = "https://${local.shared.cloudfront_distribution_domain_name}" },
    { name = "FRONTEND_ORIGIN", value = var.frontend_origin },
  ]
}

variable "allowed_account_ids" {
  type = list(string)
  default = []
}
variable "resource_tags" {
  type = map(string)
  default = {}
}
variable "project_name" {
  type = string
  default = "streaming-video"
}
variable "environment" {
  type = string
  default = "dev"
}
variable "aws_region" {
  type = string
  default = "ap-northeast-1"
}
variable "shared_state_path" {
  type = string
  description = "Path to the state of app/infra/terraform."
}
variable "frontend_origin" {
  type = string
  description = "The exact browser frontend origin."
}
variable "acm_certificate_arn" {
  type = string
  description = "Operator-supplied ACM certificate in the ALB region."
}
variable "api_image_digest" {
  type        = string
  description = "Immutable API ECR image digest (sha256:...)."
  default     = null
  validation {
    condition     = var.api_image_digest == null ? true : can(regex("^sha256:[0-9a-f]{64}$", var.api_image_digest))
    error_message = "api_image_digest must be a sha256 digest."
  }
}
variable "worker_image_digest" {
  type        = string
  description = "Immutable worker ECR image digest (sha256:...)."
  default     = null
  validation {
    condition     = var.worker_image_digest == null ? true : can(regex("^sha256:[0-9a-f]{64}$", var.worker_image_digest))
    error_message = "worker_image_digest must be a sha256 digest."
  }
}
variable "database_url_secret_arn" {
  type = string
  description = "Secrets Manager ARN containing the non-admin application DATABASE_URL."
}
variable "database_name" {
  type = string
  default = "video"
}
variable "database_username" {
  type = string
  default = "video_admin"
}
variable "db_instance_class" {
  type = string
  default = "db.t4g.micro"
}
variable "db_allocated_storage" {
  type = number
  default = 20
}
variable "api_desired_count" {
  type = number
  default = 0
}
variable "worker_desired_count" {
  type = number
  default = 0
  validation {
    condition     = var.worker_desired_count >= 0 && var.worker_desired_count <= 4 && floor(var.worker_desired_count) == var.worker_desired_count
    error_message = "worker_desired_count must be a whole number between 0 and 4."
  }
}
variable "worker_autoscaling_enabled" {
  description = "Enable only after the database secret and migrations are ready."
  type        = bool
  default     = false
}
variable "worker_autoscaling_min_capacity" {
  type    = number
  default = 1
  validation {
    condition     = var.worker_autoscaling_min_capacity >= 1 && var.worker_autoscaling_min_capacity <= 4 && floor(var.worker_autoscaling_min_capacity) == var.worker_autoscaling_min_capacity
    error_message = "Worker autoscaling minimum must be an integer from 1 through 4."
  }
}
variable "worker_autoscaling_max_capacity" {
  type    = number
  default = 4
  validation {
    condition     = var.worker_autoscaling_max_capacity >= 1 && var.worker_autoscaling_max_capacity <= 4 && floor(var.worker_autoscaling_max_capacity) == var.worker_autoscaling_max_capacity
    error_message = "Worker autoscaling maximum must be an integer from 1 through 4."
  }
}
variable "worker_cpu" {
  type = number
  default = 1024
}
variable "worker_memory" {
  type = number
  default = 2048
}
variable "worker_ephemeral_storage_gib" {
  type = number
  default = 50
}
variable "worker_stop_timeout_seconds" {
  type = number
  default = 30
}
variable "worker_max_source_bytes" {
  type = number
  default = 67108864
}
variable "worker_max_temp_bytes" {
  type = number
  default = 536870912
}
variable "worker_disk_reserve_bytes" {
  type = number
  default = 268435456
}
variable "worker_ffmpeg_threads" {
  type = number
  default = 1
}
variable "worker_max_duration_seconds" {
  type = number
  default = 3600
}
variable "worker_max_wall_seconds" {
  type = number
  default = 7200
}
variable "worker_acceptable_queue_delay_seconds" {
  type        = number
  description = "Queue delay the worker fleet should absorb, divided by representative processing time for the initial backlog target."
  default     = 900
  validation {
    condition     = var.worker_acceptable_queue_delay_seconds > 0
    error_message = "worker_acceptable_queue_delay_seconds must be positive."
  }
}
variable "worker_representative_processing_seconds" {
  type        = number
  description = "Measured representative processing time used to initialize backlog-per-worker scaling."
  default     = 300
  validation {
    condition     = var.worker_representative_processing_seconds > 0
    error_message = "worker_representative_processing_seconds must be positive."
  }
}
variable "worker_scale_out_cooldown_seconds" {
  type        = number
  description = "Bounded scale-out cooldown covering Fargate startup and metric publication."
  default     = 180
  validation {
    condition     = var.worker_scale_out_cooldown_seconds >= 60 && var.worker_scale_out_cooldown_seconds <= 900
    error_message = "worker_scale_out_cooldown_seconds must be between 60 and 900."
  }
}
variable "worker_scale_in_cooldown_seconds" {
  type        = number
  description = "Bounded scale-in cooldown covering processing and ECS task-protection release."
  default     = 600
  validation {
    condition     = var.worker_scale_in_cooldown_seconds >= 300 && var.worker_scale_in_cooldown_seconds <= 1800
    error_message = "worker_scale_in_cooldown_seconds must be between 300 and 1800."
  }
}
variable "vpc_cidr" {
  type = string
  default = "10.42.0.0/16"
}
variable "api_cpu" {
  type = number
  default = 256
}
variable "api_memory" {
  type = number
  default = 512
}
variable "migration_cpu" {
  type = number
  default = 256
}
variable "migration_memory" {
  type = number
  default = 512
}
