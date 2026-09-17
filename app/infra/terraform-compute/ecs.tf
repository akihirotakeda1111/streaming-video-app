resource "aws_ecs_cluster" "main" { name = local.name }

locals {
  api_container = {
    name = "api"
    image = local.api_image
    essential = true
    portMappings = [{ containerPort = 8080, hostPort = 8080, protocol = "tcp" }]
    environment = local.api_env
    secrets = [{ name = "DATABASE_URL", valueFrom = var.database_url_secret_arn }]
    healthCheck = { command = ["CMD-SHELL", "curl -fsS http://localhost:8080/api/v1/health || exit 1"], interval = 30, timeout = 5, retries = 3, startPeriod = 20 }
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.api.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "api" } }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api.arn
  container_definitions    = jsonencode([local.api_container])
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${local.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.migration_cpu
  memory                   = var.migration_memory
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name = "migration", image = local.api_image, essential = true,
    command = ["/bin/sh", "-c", "for f in /app/migrations/0001_phase1_schema.up.sql /app/migrations/0002_job_lease_persistence.up.sql; do psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f \"$f\"; done"],
    secrets = [{ name = "DATABASE_URL", valueFrom = var.database_url_secret_arn }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.migration.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "migration" } }
  }])
}

resource "aws_lb" "api" {
  name = substr(local.name, 0, 32)
  load_balancer_type = "application"
  subnets = aws_subnet.public[*].id
  security_groups = [aws_security_group.alb.id]
}
resource "aws_lb_target_group" "api" {
  name = substr("${local.name}-api", 0, 32)
  port = 8080
  protocol = "HTTP"
  target_type = "ip"
  vpc_id = aws_vpc.main.id
  health_check {
    path = "/api/v1/health"
    matcher = "200"
    interval = 30
    timeout = 5
    healthy_threshold = 2
    unhealthy_threshold = 3
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port = 443
  protocol = "HTTPS"
  ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.acm_certificate_arn
  default_action {
    type = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
resource "aws_ecs_service" "api" {
  name = "${local.name}-api"
  cluster = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count = var.api_desired_count
  launch_type = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent = 100
  network_configuration {
    subnets = aws_subnet.public[*].id
    security_groups = [aws_security_group.api.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name = "api"
    container_port = 8080
  }
  depends_on = [aws_lb_listener.https]
}
