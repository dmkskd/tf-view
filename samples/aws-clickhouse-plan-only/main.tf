########################################################################
# AWS + ClickHouse Cloud sample, for generating tfplanview sample plans.
#
# Shows both PrivateLink directions:
#   - AWS -> ClickHouse: an interface endpoint in the VPC to the service's
#     endpoint service, registered with the service through
#     clickhouse_service_private_endpoints_attachment.
#   - ClickHouse -> AWS: ClickPipes reach an RDS instance through an
#     endpoint service (NLB) in the VPC, via a reverse private endpoint.
# Plus ClickPipes from S3 (SQS notifications) and Kinesis using an IAM role,
# a secondary read-only service, and organization resources.
#
# PLAN-ONLY. Both providers get fake credentials and plan makes no API call.
# Usage:
#   terraform init
#   terraform plan -refresh=false -out=tfplan
#   terraform show -json tfplan > plan.json
########################################################################

terraform {
  required_version = ">= 1.5"
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
  default = "us-east-2"
}

variable "azs" {
  default = ["us-east-2a", "us-east-2b"]
}

variable "clickhouse_password_hash" {
  description = "base64 encoded sha256 hash of the default user's password"
  type        = string
  sensitive   = true
  default     = "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="
}

variable "postgres_password" {
  type      = string
  sensitive = true
  default   = "plan-only-not-a-secret"
}

provider "aws" {
  region                      = var.region
  access_key                  = "fake"
  secret_key                  = "fake"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

provider "clickhouse" {
  organization_id = "00000000-0000-0000-0000-000000000000"
  token_key       = "fake"
  token_secret    = "fake"
}

locals {
  tags = { Project = "analytics" }
}

########################################################################
# AWS networking
########################################################################

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "analytics" })
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = var.azs[count.index]
  tags              = merge(local.tags, { Name = "private-${count.index}" })
}

resource "aws_security_group" "app" {
  name        = "app"
  description = "Application hosts that query ClickHouse"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_instance" "app" {
  ami                    = "ami-0abcdef1234567890"
  instance_type          = "t3.small"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.app.id]
  tags                   = merge(local.tags, { Name = "app" })
}

########################################################################
# AWS -> ClickHouse: PrivateLink to the service
########################################################################

resource "aws_security_group" "clickhouse_endpoint" {
  name        = "clickhouse-endpoint"
  description = "Interface endpoint to ClickHouse Cloud"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "clickhouse_https" {
  security_group_id            = aws_security_group.clickhouse_endpoint.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 8443
  to_port                      = 8443
  description                  = "ClickHouse HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "clickhouse_native" {
  security_group_id            = aws_security_group.clickhouse_endpoint.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 9440
  to_port                      = 9440
  description                  = "ClickHouse native protocol (TLS)"
}

resource "aws_vpc_endpoint" "clickhouse" {
  vpc_id              = aws_vpc.main.id
  service_name        = clickhouse_service.analytics.private_endpoint_config.endpoint_service_id
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.clickhouse_endpoint.id]
  private_dns_enabled = false
  tags                = merge(local.tags, { Name = "clickhouse" })
}

# Private DNS for the service hostname, resolving to the endpoint ENIs.
resource "aws_route53_zone" "clickhouse" {
  name = "${var.region}.vpce.aws.clickhouse.cloud"
  vpc {
    vpc_id = aws_vpc.main.id
  }
  tags = local.tags
}

resource "aws_route53_record" "clickhouse" {
  zone_id = aws_route53_zone.clickhouse.zone_id
  name    = clickhouse_service.analytics.private_endpoint_config.private_dns_hostname
  type    = "CNAME"
  ttl     = 300
  records = [aws_vpc_endpoint.clickhouse.dns_entry[0].dns_name]
}

########################################################################
# ClickHouse Cloud: services
########################################################################

resource "clickhouse_service" "analytics" {
  name           = "analytics"
  cloud_provider = "aws"
  region         = var.region
  password_hash  = var.clickhouse_password_hash

  # empty list blocks access from the internet; PrivateLink only
  ip_access = []

  min_replica_memory_gb = 16
  max_replica_memory_gb = 120
  num_replicas          = 3
  idle_scaling          = false
  release_channel       = "default"

  backup_configuration = {
    backup_period_in_hours           = 24
    backup_retention_period_in_hours = 72
    backup_start_time                = null
  }

  endpoints = {
    mysql = { enabled = true }
  }

  tags = local.tags
}

# Secondary compute sharing the primary service's data (a warehouse).
resource "clickhouse_service" "reporting" {
  name           = "reporting"
  cloud_provider = "aws"
  region         = var.region
  password_hash  = var.clickhouse_password_hash
  warehouse_id   = clickhouse_service.analytics.warehouse_id
  readonly       = true

  ip_access = [
    {
      source      = "203.0.113.0/24"
      description = "Office"
    }
  ]

  min_replica_memory_gb = 8
  max_replica_memory_gb = 32
  num_replicas          = 2
  idle_scaling          = true
  idle_timeout_minutes  = 15

  tags = local.tags
}

resource "clickhouse_service_private_endpoints_attachment" "analytics" {
  service_id           = clickhouse_service.analytics.id
  private_endpoint_ids = [aws_vpc_endpoint.clickhouse.id]
}

resource "clickhouse_service_upgrade_window" "analytics" {
  service_id     = clickhouse_service.analytics.id
  weekday        = 3
  start_hour_utc = 6
}

resource "clickhouse_service_scheduled_scaling" "reporting" {
  service_id = clickhouse_service.reporting.id
  entries = [
    {
      name                  = "Business hours"
      weekdays              = [1, 2, 3, 4, 5]
      start_hour_utc        = 7
      end_hour_utc          = 19
      min_replicas          = 2
      max_replicas          = 2
      min_replica_memory_gb = 32
      max_replica_memory_gb = 32
      idle_scaling          = false
    },
  ]
}

########################################################################
# ClickHouse Cloud: organization, access, queries
########################################################################

resource "clickhouse_organization_settings" "this" {
  core_dumps_enabled = false
}

resource "clickhouse_api_key" "dashboards" {
  name  = "dashboards"
  state = "enabled"
  ip_access = [
    {
      source      = "10.20.0.0/16"
      description = "analytics VPC"
    }
  ]
}

resource "clickhouse_role" "analyst" {
  name = "analyst"
  policies = [
    {
      effect      = "ALLOW"
      permissions = ["control-plane:service:view-backups"]
      resources   = ["instance/${clickhouse_service.analytics.id}"]
    },
    {
      effect      = "ALLOW"
      permissions = ["sql-console:database:access"]
      resources   = ["instance/${clickhouse_service.reporting.id}"]
      tags = {
        grants = ["GRANT SELECT ON default.*"]
      }
    },
  ]
}

resource "clickhouse_role_assignment" "dashboards" {
  role_id     = clickhouse_role.analyst.id
  api_key_ids = [clickhouse_api_key.dashboards.id]
}

resource "clickhouse_query_api_endpoint" "daily_events" {
  service_id  = clickhouse_service.reporting.id
  name        = "daily-events"
  database    = "default"
  sql         = "SELECT toDate(timestamp) AS day, count() AS events FROM s3_events WHERE day >= {from:Date} GROUP BY day ORDER BY day"
  parameters  = { from = "2026-10-01" }
  api_key_ids = [clickhouse_api_key.dashboards.id]
  roles       = ["sql_console_read_only"]
}

resource "clickhouse_saved_query" "top_event_types" {
  service_id = clickhouse_service.reporting.id
  name       = "Top event types"
  database   = "default"
  sql        = "SELECT event_type, count() AS n FROM s3_events GROUP BY event_type ORDER BY n DESC LIMIT 20"
}

########################################################################
# ClickPipes: S3 with SQS notifications, IAM role
########################################################################

resource "aws_s3_bucket" "events" {
  bucket = "analytics-events-example"
  tags   = local.tags
}

resource "aws_sqs_queue" "events" {
  name = "analytics-events"
  tags = local.tags
}

resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.events.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_s3_bucket.events.arn } }
    }]
  })
}

resource "aws_s3_bucket_notification" "events" {
  bucket = aws_s3_bucket.events.id
  queue {
    queue_arn     = aws_sqs_queue.events.arn
    events        = ["s3:ObjectCreated:*"]
    filter_suffix = ".json"
  }
  depends_on = [aws_sqs_queue_policy.events]
}

resource "aws_kinesis_stream" "clicks" {
  name             = "clicks"
  retention_period = 24
  stream_mode_details {
    stream_mode = "ON_DEMAND"
  }
  tags = local.tags
}

# Role that ClickPipes assume, trusting the service's IAM role.
resource "aws_iam_role" "clickpipes" {
  name = "clickhouse-clickpipes"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = clickhouse_service.analytics.iam_role }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "clickpipes" {
  name = "read-sources"
  role = aws_iam_role.clickpipes.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.events.arn, "${aws_s3_bucket.events.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.events.arn
      },
      {
        Effect   = "Allow"
        Action   = ["kinesis:DescribeStream", "kinesis:GetShardIterator", "kinesis:GetRecords", "kinesis:ListShards", "kinesis:SubscribeToShard", "kinesis:RegisterStreamConsumer", "kinesis:DescribeStreamConsumer"]
        Resource = aws_kinesis_stream.clicks.arn
      },
    ]
  })
}

resource "clickhouse_clickpipe" "s3_events" {
  name       = "S3 events"
  service_id = clickhouse_service.analytics.id

  source = {
    object_storage = {
      type           = "s3"
      format         = "JSONEachRow"
      url            = "https://${aws_s3_bucket.events.bucket_regional_domain_name}/events/*.json"
      is_continuous  = true
      queue_url      = aws_sqs_queue.events.url
      authentication = "IAM_ROLE"
      iam_role       = aws_iam_role.clickpipes.arn
    }
  }

  destination = {
    table         = "s3_events"
    managed_table = true
    table_definition = {
      engine      = { type = "MergeTree" }
      sorting_key = ["timestamp"]
    }
    columns = [
      { name = "id", type = "String" },
      { name = "timestamp", type = "DateTime64(3)" },
      { name = "event_type", type = "String" },
      { name = "data", type = "String" },
    ]
  }

  field_mappings = [
    { source_field = "id", destination_field = "id" },
    { source_field = "timestamp", destination_field = "timestamp" },
    { source_field = "event_type", destination_field = "event_type" },
    { source_field = "data", destination_field = "data" },
  ]
}

resource "clickhouse_clickpipe" "kinesis_clicks" {
  name       = "Kinesis clicks"
  service_id = clickhouse_service.analytics.id

  source = {
    kinesis = {
      format               = "JSONEachRow"
      stream_name          = aws_kinesis_stream.clicks.name
      region               = var.region
      iterator_type        = "LATEST"
      use_enhanced_fan_out = true
      authentication       = "IAM_ROLE"
      iam_role             = aws_iam_role.clickpipes.arn
    }
  }

  destination = {
    table         = "clicks"
    managed_table = true
    table_definition = {
      engine = { type = "MergeTree" }
    }
    columns = [
      { name = "user_id", type = "String" },
      { name = "url", type = "String" },
      { name = "ts", type = "DateTime" },
    ]
  }

  field_mappings = [
    { source_field = "user_id", destination_field = "user_id" },
    { source_field = "url", destination_field = "url" },
    { source_field = "ts", destination_field = "ts" },
  ]
}

########################################################################
# ClickHouse -> AWS: Postgres CDC from RDS over a reverse private endpoint
########################################################################

resource "aws_db_subnet_group" "orders" {
  name       = "orders"
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}

resource "aws_security_group" "orders_db" {
  name        = "orders-db"
  description = "Orders Postgres"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "orders_db_from_vpc" {
  security_group_id = aws_security_group.orders_db.id
  cidr_ipv4         = aws_vpc.main.cidr_block
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  description       = "Postgres from the VPC (NLB and app)"
}

resource "aws_db_parameter_group" "orders" {
  name   = "orders-logical-replication"
  family = "postgres16"
  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "orders" {
  identifier             = "orders"
  engine                 = "postgres"
  engine_version         = "16.4"
  instance_class         = "db.t4g.medium"
  allocated_storage      = 50
  db_name                = "orders"
  username               = "clickpipes"
  password               = var.postgres_password
  db_subnet_group_name   = aws_db_subnet_group.orders.name
  vpc_security_group_ids = [aws_security_group.orders_db.id]
  parameter_group_name   = aws_db_parameter_group.orders.name
  skip_final_snapshot    = true
  tags                   = local.tags
}

resource "aws_lb" "orders_db" {
  name               = "orders-db"
  load_balancer_type = "network"
  internal           = true
  subnets            = aws_subnet.private[*].id
  tags               = local.tags
}

resource "aws_lb_target_group" "orders_db" {
  name        = "orders-db"
  port        = 5432
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
}

resource "aws_lb_listener" "orders_db" {
  load_balancer_arn = aws_lb.orders_db.arn
  port              = 5432
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.orders_db.arn
  }
}

resource "aws_vpc_endpoint_service" "orders_db" {
  acceptance_required        = false
  network_load_balancer_arns = [aws_lb.orders_db.arn]
  tags                       = merge(local.tags, { Name = "orders-db" })
}

# ClickPipes' AWS principal, allowed to connect to the endpoint service.
# The ClickPipes reverse private endpoint docs list the ARN per region.
variable "clickpipes_principal_arn" {
  default = "arn:aws:iam::111111111111:root"
}

resource "aws_vpc_endpoint_service_allowed_principal" "clickpipes" {
  vpc_endpoint_service_id = aws_vpc_endpoint_service.orders_db.id
  principal_arn           = var.clickpipes_principal_arn
}

resource "clickhouse_clickpipes_reverse_private_endpoint" "orders_db" {
  service_id                = clickhouse_service.analytics.id
  description               = "Orders Postgres via NLB endpoint service"
  type                      = "VPC_ENDPOINT_SERVICE"
  vpc_endpoint_service_name = aws_vpc_endpoint_service.orders_db.service_name
}

resource "clickhouse_clickpipe_cdc_infrastructure" "this" {
  service_id             = clickhouse_service.analytics.id
  replica_cpu_millicores = 2000
  replica_memory_gb      = 8
}

resource "clickhouse_clickpipe" "orders_cdc" {
  name       = "Orders CDC"
  service_id = clickhouse_service.analytics.id
  depends_on = [clickhouse_clickpipe_cdc_infrastructure.this]

  source = {
    postgres = {
      type     = "rdspostgres"
      host     = clickhouse_clickpipes_reverse_private_endpoint.orders_db.dns_names[0]
      port     = 5432
      database = aws_db_instance.orders.db_name
      tls_host = aws_db_instance.orders.address
      credentials = {
        username = aws_db_instance.orders.username
        password = var.postgres_password
      }
      settings = {
        replication_mode = "cdc"
      }
      table_mappings = [
        { source_schema_name = "public", source_table = "orders", target_table = "orders" },
        { source_schema_name = "public", source_table = "customers", target_table = "customers" },
      ]
    }
  }

  destination = {
    database = "orders"
  }
}

output "clickhouse_private_hostname" {
  value = clickhouse_service.analytics.private_endpoint_config.private_dns_hostname
}
