data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "output_public_read" {
  # videos/*/jobs/*/hls/*
  statement {
    sid     = "PublicHlsRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    resources = [
      format(
        "%s/videos/%s/jobs/%s/hls/%s",
        aws_s3_bucket.video_output.arn,
        local.s3_path_wildcard,
        local.s3_path_wildcard,
        local.s3_path_wildcard,
      ),
    ]
  }
}

data "aws_iam_policy_document" "encoding_queue_publish" {
  statement {
    sid     = "AllowInputBucketToPublish"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    resources = [aws_sqs_queue.video_encoding.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.video_input.arn]
    }
  }
}

resource "aws_s3_bucket" "video_input" {
  bucket = var.video_input_bucket
}

resource "aws_s3_bucket" "video_output" {
  bucket = var.video_output_bucket
}

resource "aws_sqs_queue" "video_encoding" {
  name = "${local.name_prefix}-encoding"
}

resource "aws_s3_bucket_public_access_block" "video_input" {
  bucket = aws_s3_bucket.video_input.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "video_output" {
  bucket = aws_s3_bucket.video_output.id

  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_cors_configuration" "video_input" {
  bucket = aws_s3_bucket.video_input.id

  cors_rule {
    allowed_headers = ["Content-Type"]
    allowed_methods = ["PUT"]
    allowed_origins = [var.frontend_origin]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_cors_configuration" "video_output" {
  bucket = aws_s3_bucket.video_output.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = [var.frontend_origin]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_policy" "video_output" {
  bucket = aws_s3_bucket.video_output.id
  policy = data.aws_iam_policy_document.output_public_read.json
}

resource "aws_sqs_queue_policy" "video_encoding" {
  queue_url = aws_sqs_queue.video_encoding.url
  policy    = data.aws_iam_policy_document.encoding_queue_publish.json
}

resource "aws_s3_bucket_notification" "video_input" {
  bucket = aws_s3_bucket.video_input.id
  depends_on = [aws_sqs_queue_policy.video_encoding]

  queue {
    queue_arn = aws_sqs_queue.video_encoding.arn
    events    = ["s3:ObjectCreated:*"]

    filter_prefix = "videos/"
    filter_suffix = "/source.mp4"
  }
}
