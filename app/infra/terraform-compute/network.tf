resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
}

data "aws_availability_zones" "available" { state = "available" }

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
}

resource "aws_subnet" "private_db" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 8)
  availability_zone = data.aws_availability_zones.available.names[0]
}

resource "aws_internet_gateway" "main" { vpc_id = aws_vpc.main.id }
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table" "private_db" { vpc_id = aws_vpc.main.id }
resource "aws_route_table_association" "private_db" {
  subnet_id      = aws_subnet.private_db.id
  route_table_id = aws_route_table.private_db.id
}

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id
  egress {
    protocol = "-1"
    from_port = 0
    to_port = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group_rule" "alb_https" {
  type = "ingress"
  security_group_id = aws_security_group.alb.id
  protocol = "tcp"
  from_port = 443
  to_port = 443
  cidr_blocks = ["0.0.0.0/0"]
}
resource "aws_security_group" "api" {
  name   = "${local.name}-api"
  vpc_id = aws_vpc.main.id
  egress {
    protocol = "-1"
    from_port = 0
    to_port = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group_rule" "api_from_alb" {
  type = "ingress"
  security_group_id = aws_security_group.api.id
  source_security_group_id = aws_security_group.alb.id
  protocol = "tcp"
  from_port = 8080
  to_port = 8080
}
resource "aws_security_group" "worker" {
  name   = "${local.name}-worker"
  vpc_id = aws_vpc.main.id
  egress {
    protocol = "-1"
    from_port = 0
    to_port = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group" "database" {
  name   = "${local.name}-database"
  vpc_id = aws_vpc.main.id
  egress {
    protocol = "-1"
    from_port = 0
    to_port = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group_rule" "database_from_api" {
  type = "ingress"
  security_group_id = aws_security_group.database.id
  source_security_group_id = aws_security_group.api.id
  protocol = "tcp"
  from_port = 5432
  to_port = 5432
}
resource "aws_security_group_rule" "database_from_worker" {
  type = "ingress"
  security_group_id = aws_security_group.database.id
  source_security_group_id = aws_security_group.worker.id
  protocol = "tcp"
  from_port = 5432
  to_port = 5432
}
