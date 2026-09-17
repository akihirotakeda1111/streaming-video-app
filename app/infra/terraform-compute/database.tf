resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private_db[*].id
}

resource "aws_db_instance" "postgres" {
  identifier                  = local.name
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage
  db_name                     = var.database_name
  username                    = var.database_username
  manage_master_user_password = true
  storage_encrypted           = true
  publicly_accessible         = false
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${local.name}-final"
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.database.id]
  backup_retention_period     = 1
  deletion_protection         = false
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 7
}
resource "aws_cloudwatch_log_group" "migration" {
  name              = "/ecs/${local.name}/migration"
  retention_in_days = 7
}
