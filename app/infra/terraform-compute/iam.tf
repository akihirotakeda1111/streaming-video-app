data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "execution" {
  name = "${local.name}-ecs-execution"
  role = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = aws_ecr_repository.api.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = ["${aws_cloudwatch_log_group.api.arn}:*", "${aws_cloudwatch_log_group.migration.arn}:*"] },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.database_url_secret_arn },
  ] })
}

resource "aws_iam_role" "api" {
  name = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "api" {
  name = "${local.name}-api-s3-presign"
  role = aws_iam_role.api.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "arn:aws:s3:::${local.shared.video_input_bucket_name}/videos/*/jobs/*/source.mp4" },
  ] })
}

resource "aws_iam_role" "worker_execution" {
  name = "${local.name}-worker-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "worker_execution" {
  name = "${local.name}-worker-execution"
  role = aws_iam_role.worker_execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = aws_ecr_repository.worker.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.worker.arn}:*" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.database_url_secret_arn },
  ] })
}

resource "aws_iam_role" "worker" {
  name = "${local.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "worker" {
  name = "${local.name}-worker-task"
  role = aws_iam_role.worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"], Resource = local.worker_queue_arn },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "arn:aws:s3:::${local.shared.video_input_bucket_name}/videos/*/jobs/*/source.mp4" },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "arn:aws:s3:::${local.shared.video_output_bucket_name}/videos/*/jobs/*/hls/*" },
    { Effect = "Allow", Action = ["ecs:UpdateTaskProtection", "ecs:GetTaskProtection"], Resource = "*" },
  ] })
}

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}
data "aws_ecr_image" "api" {
  repository_name = aws_ecr_repository.api.name
  image_digest    = var.api_image_digest
  lifecycle {
    precondition {
      condition     = var.api_image_digest != null
      error_message = "Bootstrap the ECR repository, push the API image, and set api_image_digest before full apply."
    }
  }
}
