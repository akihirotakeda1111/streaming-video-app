data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "output_cloudfront_read" {
  # videos/*/jobs/*/hls/*
  statement {
    sid     = "AllowCloudFrontHlsRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
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

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.video_output.arn]
    }
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

data "aws_iam_policy_document" "api_local_execution" {
  statement {
    sid     = "AllowPresignedInputUpload"
    effect  = "Allow"
    actions = ["s3:PutObject"]

    resources = [
      format(
        "%s/videos/%s/jobs/%s/source.mp4",
        aws_s3_bucket.video_input.arn,
        local.s3_path_wildcard,
        local.s3_path_wildcard,
      ),
    ]
  }
}

data "aws_iam_policy_document" "worker_local_execution" {
  statement {
    sid    = "AllowQueueConsumption"
    effect = "Allow"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]

    resources = [aws_sqs_queue.video_encoding.arn]
  }

  statement {
    sid     = "AllowReadInputObject"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    resources = [
      format(
        "%s/videos/%s/jobs/%s/source.mp4",
        aws_s3_bucket.video_input.arn,
        local.s3_path_wildcard,
        local.s3_path_wildcard,
      ),
    ]
  }

  statement {
    sid     = "AllowWriteHlsOutput"
    effect  = "Allow"
    actions = ["s3:PutObject"]

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

resource "aws_s3_bucket" "video_input" {
  bucket = var.video_input_bucket
}

resource "aws_s3_bucket" "video_output" {
  bucket = var.video_output_bucket
}

resource "aws_sqs_queue" "video_encoding" {
  name                       = "${local.name_prefix}-encoding"
  visibility_timeout_seconds = var.source_visibility_timeout_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.video_encoding_dlq.arn
    maxReceiveCount     = var.queue_max_receive_count
  })

  lifecycle {
    precondition {
      condition     = var.queue_max_receive_count == var.worker_maximum_attempts
      error_message = "queue_max_receive_count must equal worker_maximum_attempts."
    }
    precondition {
      condition     = 2 * var.worker_heartbeat_interval_seconds <= var.worker_visibility_extension_seconds && 2 * var.worker_heartbeat_interval_seconds <= var.worker_lease_duration_seconds && 2 * var.worker_heartbeat_interval_seconds <= var.source_visibility_timeout_seconds
      error_message = "Twice the worker heartbeat must not exceed visibility, lease, or source queue timeouts."
    }
  }
}

resource "aws_sqs_queue" "video_encoding_dlq" {
  name                    = "${local.name_prefix}-encoding-dlq"
  sqs_managed_sse_enabled = true
}

resource "aws_cloudwatch_metric_alarm" "video_encoding_oldest_message" {
  alarm_name          = "${local.name_prefix}-encoding-oldest-message"
  alarm_description   = "Source encoding queue has an old message."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.source_oldest_message_age_alarm_seconds
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.video_encoding.name }
}

resource "aws_cloudwatch_metric_alarm" "video_encoding_visible_messages" {
  alarm_name          = "${local.name_prefix}-encoding-visible-messages"
  alarm_description   = "Source encoding queue backlog is growing."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.source_visible_messages_alarm_threshold
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.video_encoding.name }
}

resource "aws_cloudwatch_metric_alarm" "video_encoding_dlq_visible_messages" {
  alarm_name          = "${local.name_prefix}-encoding-dlq-visible-messages"
  alarm_description   = "Encoding DLQ contains visible messages."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.dlq_visible_messages_alarm_threshold
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.video_encoding_dlq.name }
}

resource "aws_iam_user" "api_local_execution" {
  name = "${local.name_prefix}-api-local-execution"
}

resource "aws_iam_policy" "api_local_execution" {
  name   = "${local.name_prefix}-api-local-execution"
  policy = data.aws_iam_policy_document.api_local_execution.json
}

resource "aws_iam_user_policy_attachment" "api_local_execution" {
  user       = aws_iam_user.api_local_execution.name
  policy_arn = aws_iam_policy.api_local_execution.arn
}

resource "aws_iam_user" "worker_local_execution" {
  name = "${local.name_prefix}-worker-local-execution"
}

resource "aws_iam_policy" "worker_local_execution" {
  name   = "${local.name_prefix}-worker-local-execution"
  policy = data.aws_iam_policy_document.worker_local_execution.json
}

resource "aws_iam_user_policy_attachment" "worker_local_execution" {
  user       = aws_iam_user.worker_local_execution.name
  policy_arn = aws_iam_policy.worker_local_execution.arn
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
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "video_input" {
  bucket = aws_s3_bucket.video_input.id

  cors_rule {
    allowed_headers = ["Content-Type"]
    allowed_methods = ["PUT"]
    allowed_origins = local.frontend_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_cors_configuration" "video_output" {
  bucket = aws_s3_bucket.video_output.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = local.frontend_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_policy" "video_output" {
  bucket     = aws_s3_bucket.video_output.id
  policy     = data.aws_iam_policy_document.output_cloudfront_read.json
  depends_on = [aws_s3_bucket_public_access_block.video_output]
}

resource "aws_cloudfront_origin_access_control" "video_output" {
  name                              = "${local.name_prefix}-video-output"
  description                       = "SigV4 access to the private HLS output bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "video_output" {
  name        = "${local.name_prefix}-video-output"
  comment     = "Disable successful-response caching for mutable legacy HLS keys."
  default_ttl = 0
  max_ttl     = 0
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

resource "aws_cloudfront_origin_request_policy" "video_output" {
  name = "${local.name_prefix}-video-output-preflight"
  cookies_config { cookie_behavior = "none" }
  query_strings_config { query_string_behavior = "none" }
  headers_config {
    header_behavior = "whitelist"
    headers { items = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"] }
  }
}

resource "aws_cloudfront_response_headers_policy" "video_output" {
  name    = "${local.name_prefix}-video-output-cors"
  comment = "CORS for approved browser frontend origins, including cache hits."

  cors_config {
    access_control_allow_credentials = false
    origin_override                  = true
    access_control_allow_headers { items = ["*"] }
    access_control_allow_methods { items = ["GET", "HEAD", "OPTIONS"] }
    access_control_allow_origins { items = local.frontend_origins }
    access_control_expose_headers { items = ["ETag"] }
  }
}

resource "aws_cloudfront_distribution" "video_output" {
  enabled         = true
  comment         = "Private HLS delivery for ${local.name_prefix}"
  is_ipv6_enabled = true

  origin {
    domain_name              = aws_s3_bucket.video_output.bucket_regional_domain_name
    origin_id                = "${local.name_prefix}-video-output"
    origin_access_control_id = aws_cloudfront_origin_access_control.video_output.id
  }

  default_cache_behavior {
    target_origin_id         = "${local.name_prefix}-video-output"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods            = ["GET", "HEAD", "OPTIONS"]
    cache_policy_id           = aws_cloudfront_cache_policy.video_output.id
    origin_request_policy_id  = aws_cloudfront_origin_request_policy.video_output.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.video_output.id
  }

  custom_error_response {
    error_code            = 403
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate { cloudfront_default_certificate = true }
}

resource "aws_sqs_queue_policy" "video_encoding" {
  queue_url = aws_sqs_queue.video_encoding.url
  policy    = data.aws_iam_policy_document.encoding_queue_publish.json
}

resource "aws_s3_bucket_notification" "video_input" {
  bucket     = aws_s3_bucket.video_input.id
  depends_on = [aws_sqs_queue_policy.video_encoding]

  queue {
    queue_arn = aws_sqs_queue.video_encoding.arn
    events    = ["s3:ObjectCreated:*"]

    filter_prefix = "videos/"
    filter_suffix = "/source.mp4"
  }
}
