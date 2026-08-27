data "aws_caller_identity" "current" {}

locals {
  name_prefix             = "streaming-video-app-agent-report"
  bucket_name             = "${local.name_prefix}-${data.aws_caller_identity.current.account_id}"
  object_prefix           = "agent-work/${var.github_repository}/"
  object_resource_pattern = "${aws_s3_bucket.agent_report.arn}/${local.object_prefix}*"
}

resource "aws_s3_bucket" "agent_report" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_public_access_block" "agent_report" {
  bucket = aws_s3_bucket.agent_report.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "agent_report" {
  bucket = aws_s3_bucket.agent_report.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "agent_report" {
  bucket = aws_s3_bucket.agent_report.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "agent_report" {
  bucket = aws_s3_bucket.agent_report.id

  rule {
    id     = "expire-agent-reports"
    status = "Enabled"

    filter {
      prefix = "agent-work/"
    }

    expiration {
      days = var.agent_report_retention_days
    }
  }
}

data "aws_iam_policy_document" "agent_report_upload" {
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = [local.object_resource_pattern]
  }
}

data "aws_iam_policy_document" "agent_report_download" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.object_resource_pattern]
  }
}

resource "aws_iam_user" "agent_report_upload" {
  name = "${local.name_prefix}-upload"
}

resource "aws_iam_user" "agent_report_download" {
  name = "${local.name_prefix}-download"
}

resource "aws_iam_policy" "agent_report_upload" {
  name   = "${local.name_prefix}-upload"
  policy = data.aws_iam_policy_document.agent_report_upload.json
}

resource "aws_iam_policy" "agent_report_download" {
  name   = "${local.name_prefix}-download"
  policy = data.aws_iam_policy_document.agent_report_download.json
}

resource "aws_iam_user_policy_attachment" "agent_report_upload" {
  user       = aws_iam_user.agent_report_upload.name
  policy_arn = aws_iam_policy.agent_report_upload.arn
}

resource "aws_iam_user_policy_attachment" "agent_report_download" {
  user       = aws_iam_user.agent_report_download.name
  policy_arn = aws_iam_policy.agent_report_download.arn
}
