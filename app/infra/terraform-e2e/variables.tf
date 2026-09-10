variable "aws_account_id" {
  type        = string
  description = "Expected AWS account; both provider configurations enforce this value."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must contain exactly 12 digits."
  }
}

variable "aws_region" {
  type    = string
  default = "ap-northeast-1"
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region)) && length(var.aws_region) <= 14
    error_message = "Use a commercial AWS region name of at most 14 characters supported by the E2E adapter."
  }
}

variable "instance" {
  type        = string
  description = "Short dedicated environment ID. Use a separate directory/state for each instance."
  default     = "local"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,4}[a-z0-9]$", var.instance))
    error_message = "instance must be 2-6 lowercase letters/digits/hyphens, starting and ending with a letter or digit."
  }
}

variable "frontend_origin" {
  type    = string
  default = "http://localhost:5173"
}

variable "timing_profile" {
  type        = string
  description = "Timing preset for this entire dedicated environment: standard, or lifecycle for crash/heartbeat tests."
  default     = "standard"
  nullable    = false
  validation {
    condition     = contains(["standard", "lifecycle"], var.timing_profile)
    error_message = "timing_profile must be standard or lifecycle."
  }
}
