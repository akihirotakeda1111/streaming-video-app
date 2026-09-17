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
  api_image = "${aws_ecr_repository.api.repository_url}@${var.api_image_digest}"
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

variable "allowed_account_ids" { type = list(string)
  default = [] }
variable "resource_tags" { type = map(string)
  default = {} }
variable "project_name" { type = string
  default = "streaming-video" }
variable "environment" { type = string
  default = "dev" }
variable "aws_region" { type = string
  default = "ap-northeast-1" }
variable "shared_state_path" { type = string
  description = "Path to the state of app/infra/terraform." }
variable "frontend_origin" { type = string
  description = "The exact browser frontend origin." }
variable "acm_certificate_arn" { type = string
  description = "Operator-supplied ACM certificate in the ALB region." }
variable "api_image_digest" {
  type        = string
  description = "Immutable API ECR image digest (sha256:...)."
  validation { condition = can(regex("^sha256:[0-9a-f]{64}$", var.api_image_digest)), error_message = "api_image_digest must be a sha256 digest." }
}
variable "database_url_secret_arn" { type = string
  description = "Secrets Manager ARN containing the non-admin application DATABASE_URL." }
variable "database_name" { type = string
  default = "video" }
variable "database_username" { type = string
  default = "rdsadmin" }
variable "db_instance_class" { type = string
  default = "db.t4g.micro" }
variable "db_allocated_storage" { type = number
  default = 20 }
variable "api_desired_count" { type = number
  default = 1 }
variable "vpc_cidr" { type = string
  default = "10.42.0.0/16" }
variable "api_cpu" { type = number
  default = 256 }
variable "api_memory" { type = number
  default = 512 }
variable "migration_cpu" { type = number
  default = 256 }
variable "migration_memory" { type = number
  default = 512 }
