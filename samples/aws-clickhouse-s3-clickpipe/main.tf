########################################################################
# AWS + ClickHouse Cloud with an S3 ClickPipe. Applies for real.
#
# Data path:
#   EC2 producer -> S3 (gateway endpoint) -> S3 event -> SQS
#   ClickPipe (IAM role) <- SQS notification, reads the object -> events table
#   EC2 -> ClickHouse Managed Postgres (public, TLS) -> CDC ClickPipe -> pg_orders_cdc
# Query path:
#   EC2 -> interface VPC endpoint (PrivateLink) -> ClickHouse service
#
# Credentials:
#   AWS:        default credential chain.
#   ClickHouse: CLICKHOUSE_ORG_ID, CLICKHOUSE_CLOUD_API_KEY,
#               CLICKHOUSE_CLOUD_API_SECRET (just loads ~/.clickhouse.env).
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
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

variable "region" {
  description = "AWS region, also used for the ClickHouse service"
  default     = "us-east-1"
}

variable "name" {
  default = "tfpv-pipes"
}

variable "pg_size" {
  description = "Managed Postgres instance size; m6gd.large is the smallest the docs name"
  type        = string
  default     = "m6gd.large"
}

variable "pg_pipe" {
  description = "Replicate Postgres into ClickHouse with a CDC ClickPipe (billed CDC workers)"
  type        = bool
  default     = true
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

########################################################################
# AWS networking
########################################################################

resource "aws_vpc" "main" {
  cidr_block           = "10.43.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${var.name}-public-${count.index}" }
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

# S3 traffic from the VPC stays on the AWS network.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]
  tags              = { Name = "${var.name}-s3" }
}

########################################################################
# EC2 client: produces events to S3, queries ClickHouse. SSM only.
########################################################################

resource "aws_security_group" "client" {
  name        = "${var.name}-client"
  description = "Producer and ClickHouse client, egress only"
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

resource "aws_iam_role_policy" "client_produce" {
  name = "produce-events"
  role = aws_iam_role.client.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "s3:PutObject"
      Resource = "${aws_s3_bucket.events.arn}/events/*"
    }]
  })
}

resource "aws_iam_instance_profile" "client" {
  name = "${var.name}-client"
  role = aws_iam_role.client.name
}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "client" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.value
  instance_type               = "t4g.micro" # free tier
  subnet_id                   = aws_subnet.public[0].id
  associate_public_ip_address = true # SSM agent reaches SSM over the internet
  vpc_security_group_ids      = [aws_security_group.client.id]
  iam_instance_profile        = aws_iam_instance_profile.client.name
  tags                        = { Name = "${var.name}-client" }

  lifecycle {
    ignore_changes = [ami]
  }
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

  # PrivateLink only.
  ip_access = []

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
# AWS -> ClickHouse: PrivateLink
########################################################################

resource "aws_security_group" "clickhouse_endpoint" {
  name        = "${var.name}-clickhouse-endpoint"
  description = "Interface endpoint to ClickHouse Cloud"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "clickhouse_https" {
  security_group_id            = aws_security_group.clickhouse_endpoint.id
  referenced_security_group_id = aws_security_group.client.id
  ip_protocol                  = "tcp"
  from_port                    = 8443
  to_port                      = 8443
  description                  = "ClickHouse HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "clickhouse_native" {
  security_group_id            = aws_security_group.clickhouse_endpoint.id
  referenced_security_group_id = aws_security_group.client.id
  ip_protocol                  = "tcp"
  from_port                    = 9440
  to_port                      = 9440
  description                  = "ClickHouse native protocol (TLS)"
}

resource "aws_vpc_endpoint" "clickhouse" {
  vpc_id              = aws_vpc.main.id
  service_name        = clickhouse_service.main.private_endpoint_config.endpoint_service_id
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.public[*].id
  security_group_ids  = [aws_security_group.clickhouse_endpoint.id]
  private_dns_enabled = false
  tags                = { Name = "${var.name}-clickhouse" }
}

resource "aws_route53_zone" "clickhouse" {
  name = "${var.region}.vpce.aws.clickhouse.cloud"
  vpc {
    vpc_id = aws_vpc.main.id
  }
}

resource "aws_route53_record" "clickhouse" {
  zone_id = aws_route53_zone.clickhouse.zone_id
  name    = clickhouse_service.main.private_endpoint_config.private_dns_hostname
  type    = "CNAME"
  ttl     = 300
  records = [aws_vpc_endpoint.clickhouse.dns_entry[0].dns_name]
}

resource "clickhouse_service_private_endpoints_attachment" "main" {
  service_id           = clickhouse_service.main.id
  private_endpoint_ids = [aws_vpc_endpoint.clickhouse.id]
}

########################################################################
# S3 events: bucket, SQS notifications
########################################################################

resource "aws_s3_bucket" "events" {
  bucket_prefix = "${var.name}-events-"
  force_destroy = true
}

resource "aws_sqs_queue" "events" {
  name                       = "${var.name}-events"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 86400
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
    filter_prefix = "events/"
    filter_suffix = ".json"
  }
  depends_on = [aws_sqs_queue_policy.events]
}

# One file so the initial load has data.
resource "aws_s3_object" "seed" {
  bucket       = aws_s3_bucket.events.id
  key          = "events/0000-seed.json"
  content_type = "application/json"
  content      = <<-EOT
    {"id":"seed-1","ts":"2026-01-01 00:00:00.000","event_type":"signup","user_id":1,"value":0}
    {"id":"seed-2","ts":"2026-01-01 00:00:01.000","event_type":"login","user_id":1,"value":0}
  EOT
  depends_on   = [aws_s3_bucket_notification.events]
}

########################################################################
# ClickPipe: S3 -> events table, IAM role
########################################################################

resource "aws_iam_role" "clickpipes" {
  name = "${var.name}-clickpipes"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = clickhouse_service.main.iam_role }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "clickpipes" {
  name = "read-events"
  role = aws_iam_role.clickpipes.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"]
        Resource = [aws_s3_bucket.events.arn, "${aws_s3_bucket.events.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
        Resource = aws_sqs_queue.events.arn
      },
    ]
  })
}

# IAM is eventually consistent; ClickPipes checks access at creation.
resource "time_sleep" "clickpipes_iam" {
  create_duration = "20s"
  depends_on      = [aws_iam_role_policy.clickpipes]
}

resource "clickhouse_clickpipe" "events" {
  name       = "S3 events"
  service_id = clickhouse_service.main.id
  depends_on = [time_sleep.clickpipes_iam, aws_s3_object.seed]

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
    table         = "events"
    managed_table = true
    table_definition = {
      engine      = { type = "MergeTree" }
      sorting_key = ["event_type", "ts"]
    }
    columns = [
      { name = "id", type = "String" },
      { name = "ts", type = "DateTime64(3)" },
      { name = "event_type", type = "LowCardinality(String)" },
      { name = "user_id", type = "UInt32" },
      { name = "value", type = "Float64" },
    ]
  }

  field_mappings = [
    { source_field = "id", destination_field = "id" },
    { source_field = "ts", destination_field = "ts" },
    { source_field = "event_type", destination_field = "event_type" },
    { source_field = "user_id", destination_field = "user_id" },
    { source_field = "value", destination_field = "value" },
  ]
}

########################################################################
# ClickHouse Managed Postgres
#
# The Postgres service has no IP allowlist or private endpoint in the
# provider yet: EC2 and ClickHouse reach it on its public hostname, TLS.
#
# The CDC ClickPipe keeps pg_orders_cdc in sync. `just pg-link` adds
# pg_orders_live, a PostgreSQL engine table that reads Postgres per query
# (SQL, not in the plan).
########################################################################

resource "random_password" "pg" {
  length      = 24
  special     = false
  min_upper   = 1
  min_lower   = 1
  min_numeric = 1
}

resource "clickhouse_postgres_service" "app" {
  name             = "${var.name}-pg"
  cloud_provider   = "aws"
  region           = var.region
  size             = var.pg_size
  postgres_version = "18"
  ha_type          = "none"

  # `just pg-link`, `just produce-pg` and the pipe need it back, so not
  # password_wo
  password = random_password.pg.result
}

data "clickhouse_postgres_service_ca_certificates" "app" {
  service_id = clickhouse_postgres_service.app.id
}

# The CDC pipe checks the source table at creation, and
# the provider has no table resource. Runs psql where terraform runs.
resource "terraform_data" "pg_schema" {
  triggers_replace = [clickhouse_postgres_service.app.id]

  provisioner "local-exec" {
    command = <<-EOT
      psql -v ON_ERROR_STOP=1 -c "
        CREATE TABLE IF NOT EXISTS public.orders (
          id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          created_at  timestamptz NOT NULL DEFAULT now(),
          customer_id integer NOT NULL,
          status      text NOT NULL,
          amount      numeric(10,2) NOT NULL
        )"
    EOT
    environment = {
      PGHOST     = clickhouse_postgres_service.app.hostname
      PGPORT     = tostring(clickhouse_postgres_service.app.port)
      PGUSER     = clickhouse_postgres_service.app.username
      PGPASSWORD = random_password.pg.result
      PGDATABASE = "postgres"
      PGSSLMODE  = "require"
    }
  }
}

resource "clickhouse_clickpipe" "orders" {
  count      = var.pg_pipe ? 1 : 0
  name       = "Postgres orders"
  service_id = clickhouse_service.main.id
  depends_on = [terraform_data.pg_schema]

  source = {
    postgres = {
      type           = "postgres"
      host           = clickhouse_postgres_service.app.hostname
      port           = clickhouse_postgres_service.app.port
      database       = "postgres"
      ca_certificate = data.clickhouse_postgres_service_ca_certificates.app.certificate
      credentials = {
        username = clickhouse_postgres_service.app.username
        password = random_password.pg.result
      }
      settings = {
        replication_mode = "cdc"
      }
      table_mappings = [
        { source_schema_name = "public", source_table = "orders", target_table = "pg_orders_cdc" },
      ]
    }
  }

  destination = {
    database = "default"
  }
}

# The CDC scaling API returns 404 until the first DB pipe has provisioned
# (about 4 min). The provider's own check passes before that, so poll the
# pipe state through the Cloud API until Running. Uses the provider's env
# credentials.
resource "terraform_data" "cdc_provisioned" {
  count            = var.pg_pipe ? 1 : 0
  triggers_replace = [clickhouse_clickpipe.orders[0].id]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      url="https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_ORG_ID/services/$SERVICE_ID/clickpipes/$PIPE_ID"
      for _ in $(seq 60); do
        state=$(curl -sS --fail --user "$CLICKHOUSE_CLOUD_API_KEY:$CLICKHOUSE_CLOUD_API_SECRET" "$url" |
          python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["state"])')
        echo "pipe $PIPE_ID: $state"
        case "$state" in
          Running) exit 0 ;;
          Failed | InternalError) exit 1 ;;
        esac
        sleep 15
      done
      echo "pipe not Running after 15 min" >&2
      exit 1
    EOT
    environment = {
      SERVICE_ID = clickhouse_service.main.id
      PIPE_ID    = clickhouse_clickpipe.orders[0].id
    }
  }
}

# Smallest CDC workers.
resource "clickhouse_clickpipe_cdc_infrastructure" "main" {
  count                  = var.pg_pipe ? 1 : 0
  service_id             = clickhouse_service.main.id
  replica_cpu_millicores = 1000
  replica_memory_gb      = 4
  depends_on             = [terraform_data.cdc_provisioned]
}

########################################################################
# Outputs
########################################################################

output "client_instance_id" {
  value = aws_instance.client.id
}

output "clickhouse_host" {
  value = clickhouse_service.main.private_endpoint_config.private_dns_hostname
}

output "clickhouse_password" {
  value     = clickhouse_service.main.generated_password
  sensitive = true
}

output "events_bucket" {
  value = aws_s3_bucket.events.bucket
}

output "clickpipe_state" {
  value = clickhouse_clickpipe.events.state
}

output "pg_host" {
  value = clickhouse_postgres_service.app.hostname
}

output "pg_user" {
  value = clickhouse_postgres_service.app.username
}

output "pg_password" {
  value     = random_password.pg.result
  sensitive = true
}

output "pg_clickpipe_state" {
  value = one(clickhouse_clickpipe.orders[*].state)
}
