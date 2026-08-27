variable "aws_region" {
  type        = string
  description = "AWS region for the agent work-report bucket."
  default     = "ap-northeast-1"
}

variable "github_repository" {
  type        = string
  description = "GitHub repository allowed to exchange work reports with S3."
  default     = "akihirotakeda1111/streaming-video-app"
}

variable "github_actions_oidc_subject" {
  type        = string
  description = "Exact GitHub Actions OIDC subject allowed to assume the work-report roles."
  default     = "repo:akihirotakeda1111/streaming-video-app:ref:refs/heads/dev"
}

variable "agent_report_retention_days" {
  type        = number
  description = "Number of days to retain agent work reports in S3."
  default     = 1

  validation {
    condition     = var.agent_report_retention_days >= 1
    error_message = "agent_report_retention_days must be at least 1."
  }
}
