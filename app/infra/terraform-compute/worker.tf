resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = 7
}

resource "aws_ecr_repository" "worker" {
  name                 = "${local.name}-worker"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

data "aws_ecr_image" "worker" {
  repository_name = aws_ecr_repository.worker.name
  image_digest    = var.worker_image_digest
  lifecycle {
    precondition {
      condition     = var.worker_image_digest != null
      error_message = "Bootstrap the worker ECR repository, push the worker image, and set worker_image_digest before full apply."
    }
  }
}

locals {
  worker_image = "${aws_ecr_repository.worker.repository_url}@${data.aws_ecr_image.worker.image_digest}"
  worker_queue_arn = "arn:aws:sqs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${element(split("/", local.shared.video_encoding_queue_url), 4)}"
  worker_container = {
    name      = "worker"
    image     = local.worker_image
    essential = true
    stopTimeout = var.worker_stop_timeout_seconds
    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "VIDEO_ENCODING_QUEUE_URL", value = local.shared.video_encoding_queue_url },
      { name = "VIDEO_INPUT_BUCKET", value = local.shared.video_input_bucket_name },
      { name = "VIDEO_OUTPUT_BUCKET", value = local.shared.video_output_bucket_name },
      { name = "WORKER_RUNTIME_MODE", value = "ecs" },
      { name = "WORKER_MAX_CONCURRENCY", value = "1" },
      { name = "WORKER_HEARTBEAT_INTERVAL_SECONDS", value = tostring(local.shared.runtime_configuration.worker_heartbeat_interval_seconds) },
      { name = "WORKER_VISIBILITY_EXTENSION_SECONDS", value = tostring(local.shared.runtime_configuration.worker_visibility_extension_seconds) },
      { name = "WORKER_LEASE_DURATION_SECONDS", value = tostring(local.shared.runtime_configuration.worker_lease_duration_seconds) },
      { name = "WORKER_RETRY_DELAY_SECONDS", value = tostring(local.shared.runtime_configuration.worker_retry_delay_seconds) },
      { name = "WORKER_MAXIMUM_ATTEMPTS", value = tostring(local.shared.runtime_configuration.worker_maximum_attempts) },
      { name = "DATABASE_CA_CERT_PATH", value = "/app/certs/rds-global-bundle.pem" },
      { name = "WORKER_MAX_SOURCE_BYTES", value = tostring(var.worker_max_source_bytes) },
      { name = "WORKER_MAX_TEMP_BYTES", value = tostring(var.worker_max_temp_bytes) },
      { name = "WORKER_DISK_RESERVE_BYTES", value = tostring(var.worker_disk_reserve_bytes) },
      { name = "WORKER_FFMPEG_THREADS", value = tostring(var.worker_ffmpeg_threads) },
      { name = "WORKER_MAX_DURATION_SECONDS", value = tostring(var.worker_max_duration_seconds) },
      { name = "WORKER_MAX_WALL_SECONDS", value = tostring(var.worker_max_wall_seconds) },
    ]
    secrets = [{ name = "DATABASE_URL", valueFrom = var.database_url_secret_arn }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.worker.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "worker" } }
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.worker_execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  ephemeral_storage { size_in_gib = var.worker_ephemeral_storage_gib }
  container_definitions = jsonencode([local.worker_container])
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  lifecycle {
    ignore_changes = [desired_count]
  }
  launch_type     = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = true
  }
}
