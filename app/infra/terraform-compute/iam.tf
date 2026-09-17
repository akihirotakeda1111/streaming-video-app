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
