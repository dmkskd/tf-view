########################################################################
# Minimal AWS + ClickHouse Cloud stack that applies for real.
#
# AWS:        VPC, public subnet, EC2 client (SSM, no SSH), S3 bucket.
# ClickHouse: one service in the same region.
# Links:
#   - AWS -> ClickHouse: the EC2 Elastic IP is the only entry in the
#     service's IP access list (HTTPS 8443). With var.private_link = true
#     the service is reached over an interface endpoint instead and the
#     IP access list is empty (needs the Scale or Enterprise plan).
#   - ClickHouse -> AWS: the service reads the S3 bucket by assuming an
#     IAM role that trusts the service's iam_role.
#
# Credentials:
#   AWS:        normal credential chain (env, ~/.aws, SSO).
#   ClickHouse: CLICKHOUSE_ORG_ID, CLICKHOUSE_CLOUD_API_KEY,
#               CLICKHOUSE_CLOUD_API_SECRET (console: Organization > API keys).
########################################################################

terraform {
  required_version = ">= 1.11" # password_wo
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    clickhouse = {
      source  = "ClickHouse/clickhouse"
      version = "~> 3.39"
    }
  }
}

variable "region" {
  description = "AWS region, also used for the ClickHouse service"
  default     = "us-east-1"
}

variable "name" {
  default = "tfpv-ch"
}

variable "private_link" {
  description = "Reach the service over PrivateLink instead of its public endpoint. Needs Scale or Enterprise."
  type        = bool
  default     = false
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = var.name }
  }
}

provider "clickhouse" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

########################################################################
# AWS networking
########################################################################

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${count.index}" }
}

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

########################################################################
# AWS client: EC2 managed through SSM, fixed public IP
########################################################################

resource "aws_security_group" "client" {
  name        = "${var.name}-client"
  description = "ClickHouse client, egress only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "client_all" {
  security_group_id = aws_security_group.client.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_iam_role" "client" {
  name = "${var.name}-client"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "client_ssm" {
  role       = aws_iam_role.client.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "client" {
  name = "${var.name}-client"
  role = aws_iam_role.client.name
}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = "t4g.micro" # free tier
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.client.id]
  iam_instance_profile   = aws_iam_instance_profile.client.name
  tags                   = { Name = "${var.name}-client" }

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_eip" "client" {
  instance   = aws_instance.client.id
  domain     = "vpc"
  depends_on = [aws_internet_gateway.main]
}

########################################################################
# ClickHouse Cloud service
########################################################################

resource "clickhouse_service" "main" {
  name           = var.name
  cloud_provider = "aws"
  region         = var.region

  # Empty password_wo asks ClickHouse to generate one (see generated_password).
  password_wo         = ""
  password_wo_version = 1

  ip_access = var.private_link ? [] : [
    {
      source      = "${aws_eip.client.public_ip}/32"
      description = "${var.name} EC2 client"
    }
  ]

  # Sizing and settings set explicitly; unset, the API picks org defaults
  # and the plan shows them as unknown.
  autoscaling_mode      = "vertical"
  num_replicas          = 3
  min_replica_memory_gb = 8
  max_replica_memory_gb = 8
  idle_scaling          = true
  idle_timeout_minutes  = 5
  release_channel       = "default"
  enable_core_dumps     = true

  backup_configuration = {
    backup_period_in_hours           = 24
    backup_retention_period_in_hours = 24
  }

  endpoints = {
    mysql = { enabled = false }
  }
}

########################################################################
# ClickHouse -> AWS: S3 read through an IAM role
########################################################################

resource "aws_s3_bucket" "data" {
  bucket_prefix = "${var.name}-data-"
  force_destroy = true
}

resource "aws_s3_object" "sample" {
  bucket       = aws_s3_bucket.data.id
  key          = "sample/cities.csv"
  content_type = "text/csv"
  content      = <<-EOT
    city,country,population
    Rome,IT,2761632
    Berlin,DE,3878100
    Lisbon,PT,567131
  EOT
}

resource "aws_iam_role" "clickhouse_s3" {
  name = "${var.name}-clickhouse-s3"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = clickhouse_service.main.iam_role }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "clickhouse_s3" {
  name = "read-data"
  role = aws_iam_role.clickhouse_s3.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"]
      Resource = [aws_s3_bucket.data.arn, "${aws_s3_bucket.data.arn}/*"]
    }]
  })
}

########################################################################
# Optional: AWS -> ClickHouse over PrivateLink
########################################################################

resource "aws_security_group" "clickhouse_endpoint" {
  count       = var.private_link ? 1 : 0
  name        = "${var.name}-clickhouse-endpoint"
  description = "Interface endpoint to ClickHouse Cloud"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "clickhouse_https" {
  count                        = var.private_link ? 1 : 0
  security_group_id            = aws_security_group.clickhouse_endpoint[0].id
  referenced_security_group_id = aws_security_group.client.id
  ip_protocol                  = "tcp"
  from_port                    = 8443
  to_port                      = 8443
  description                  = "ClickHouse HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "clickhouse_native" {
  count                        = var.private_link ? 1 : 0
  security_group_id            = aws_security_group.clickhouse_endpoint[0].id
  referenced_security_group_id = aws_security_group.client.id
  ip_protocol                  = "tcp"
  from_port                    = 9440
  to_port                      = 9440
  description                  = "ClickHouse native protocol (TLS)"
}

resource "aws_vpc_endpoint" "clickhouse" {
  count               = var.private_link ? 1 : 0
  vpc_id              = aws_vpc.main.id
  service_name        = clickhouse_service.main.private_endpoint_config.endpoint_service_id
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.public[*].id
  security_group_ids  = [aws_security_group.clickhouse_endpoint[0].id]
  private_dns_enabled = false
  tags                = { Name = "${var.name}-clickhouse" }
}

resource "aws_route53_zone" "clickhouse" {
  count = var.private_link ? 1 : 0
  name  = "${var.region}.vpce.aws.clickhouse.cloud"
  vpc {
    vpc_id = aws_vpc.main.id
  }
}

resource "aws_route53_record" "clickhouse" {
  count   = var.private_link ? 1 : 0
  zone_id = aws_route53_zone.clickhouse[0].zone_id
  name    = clickhouse_service.main.private_endpoint_config.private_dns_hostname
  type    = "CNAME"
  ttl     = 300
  records = [aws_vpc_endpoint.clickhouse[0].dns_entry[0].dns_name]
}

resource "clickhouse_service_private_endpoints_attachment" "main" {
  count                = var.private_link ? 1 : 0
  service_id           = clickhouse_service.main.id
  private_endpoint_ids = [aws_vpc_endpoint.clickhouse[0].id]
}

########################################################################
# Outputs
########################################################################

locals {
  clickhouse_host = var.private_link ? clickhouse_service.main.private_endpoint_config.private_dns_hostname : clickhouse_service.main.endpoints.https.host
}

output "client_instance_id" {
  value = aws_instance.client.id
}

output "client_public_ip" {
  value = aws_eip.client.public_ip
}

output "clickhouse_host" {
  value = local.clickhouse_host
}

output "clickhouse_password" {
  value     = clickhouse_service.main.generated_password
  sensitive = true
}

output "s3_url" {
  value = "https://${aws_s3_bucket.data.bucket_regional_domain_name}/${aws_s3_object.sample.key}"
}

output "s3_role_arn" {
  value = aws_iam_role.clickhouse_s3.arn
}
