# Web-app stack for the Atlantis demo. Runs against Floci (local AWS emulator), no AWS account needed.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # State lives in Floci's S3 so it survives between merge requests (setup creates the bucket).
  backend "s3" {
    bucket                      = "tfstate"
    key                         = "demo/terraform.tfstate"
    region                      = "us-east-1"
    access_key                  = "test"
    secret_key                  = "test"
    endpoints                   = { s3 = "http://floci:4566" }
    use_path_style              = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
  }
}

# The platform (network, load balancer, database, sessions table, a legacy bucket) is applied once at `just up`.
# The MR then builds the app on top of it by switching these on, changing one setting and removing the legacy bucket.
variable "app" {
  description = "App tier: IAM role, launch template, auto scaling group, log group."
  type        = bool
  default     = false
}

variable "storage" {
  description = "Assets bucket and the app's read access to it."
  type        = bool
  default     = false
}

variable "messaging" {
  description = "SNS topic and SQS queue, subscribed to each other."
  type        = bool
  default     = false
}

variable "legacy" {
  description = "Old export bucket that already exists; switching it off deletes it."
  type        = bool
  default     = true
}

variable "health_path" {
  description = "Health check path of the load balancer's target group; changing it is an in-place update."
  type        = string
  default     = "/"
}

variable "db_password" {
  description = "Demo database password (fake, local only)."
  type        = string
  default     = "change-me-demo"
  sensitive   = true
}

variable "endpoint" {
  type    = string
  default = "http://floci:4566"
}

locals {
  endpoint = var.endpoint
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
  endpoints {
    ec2            = local.endpoint
    s3             = local.endpoint
    sqs            = local.endpoint
    sns            = local.endpoint
    iam            = local.endpoint
    sts            = local.endpoint
    kms            = local.endpoint
    elbv2          = local.endpoint
    rds            = local.endpoint
    autoscaling    = local.endpoint
    cloudwatchlogs = local.endpoint
    dynamodb       = local.endpoint
  }
}

# ---------------------------------------------------------------- platform: network
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "demo" }
}

resource "aws_subnet" "public_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "us-east-1a"
  tags              = { Name = "demo-public-a" }
}

resource "aws_subnet" "public_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "us-east-1b"
  tags              = { Name = "demo-public-b" }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.11.0/24"
  availability_zone = "us-east-1a"
  tags              = { Name = "demo-private-a" }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.12.0/24"
  availability_zone = "us-east-1b"
  tags              = { Name = "demo-private-b" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "demo" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "demo-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_a.id
  tags          = { Name = "demo" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "demo-public" }
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "demo-private" }
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------- platform: security groups
resource "aws_security_group" "alb" {
  name   = "demo-alb"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "app" {
  name   = "demo-app"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
}

resource "aws_security_group" "db" {
  name   = "demo-db"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

# ---------------------------------------------------------------- platform: load balancer
resource "aws_lb" "main" {
  name               = "demo-alb"
  load_balancer_type = "application"
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "app" {
  name     = "demo-app"
  port     = 8080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
  health_check {
    path = var.health_path
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ---------------------------------------------------------------- platform: data
resource "aws_db_subnet_group" "main" {
  name       = "demo-db"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_db_instance" "main" {
  identifier             = "demo-db"
  engine                 = "postgres"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  username               = "demo"
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  skip_final_snapshot    = true
}

resource "aws_dynamodb_table" "sessions" {
  name         = "demo-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute {
    name = "id"
    type = "S"
  }
}

# A legacy bucket that already exists and that the MR removes
resource "aws_s3_bucket" "legacy" {
  count  = var.legacy ? 1 : 0
  bucket = "demo-legacy-exports"
  tags   = { Name = "demo-legacy-exports" }
}

# ---------------------------------------------------------------- added by the MR: the app
resource "aws_cloudwatch_log_group" "app" {
  count = var.app ? 1 : 0
  name  = "/demo/app"
}

resource "aws_iam_role" "app" {
  count = var.app ? 1 : 0
  name  = "demo-app"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_instance_profile" "app" {
  count = var.app ? 1 : 0
  name  = "demo-app"
  role  = aws_iam_role.app[0].name
}

resource "aws_launch_template" "app" {
  count                  = var.app ? 1 : 0
  name                   = "demo-app"
  image_id               = "ami-12345678"
  instance_type          = "t3.micro"
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile {
    name = aws_iam_instance_profile.app[0].name
  }
}

resource "aws_autoscaling_group" "app" {
  count               = var.app ? 1 : 0
  name                = "demo-app"
  min_size            = 1
  max_size            = 2
  vpc_zone_identifier = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  target_group_arns   = [aws_lb_target_group.app.arn]
  launch_template {
    id      = aws_launch_template.app[0].id
    version = "$Latest"
  }
}

# ---------------------------------------------------------------- added by the MR: storage
resource "aws_s3_bucket" "assets" {
  count  = var.storage ? 1 : 0
  bucket = "demo-assets"
}

resource "aws_s3_bucket_versioning" "assets" {
  count  = var.storage ? 1 : 0
  bucket = aws_s3_bucket.assets[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_iam_role_policy" "assets_read" {
  count = var.app && var.storage ? 1 : 0
  name  = "assets-read"
  role  = aws_iam_role.app[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["s3:GetObject", "s3:ListBucket"], Resource = [aws_s3_bucket.assets[0].arn, "${aws_s3_bucket.assets[0].arn}/*"] }]
  })
}

# ---------------------------------------------------------------- added by the MR: messaging
resource "aws_sns_topic" "alerts" {
  count = var.messaging ? 1 : 0
  name  = "demo-alerts"
}

resource "aws_sqs_queue" "jobs" {
  count = var.messaging ? 1 : 0
  name  = "demo-jobs"
}

resource "aws_sns_topic_subscription" "jobs" {
  count     = var.messaging ? 1 : 0
  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.jobs[0].arn
}

resource "aws_sqs_queue_policy" "jobs" {
  count     = var.messaging ? 1 : 0
  queue_url = aws_sqs_queue.jobs[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.jobs[0].arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.alerts[0].arn } }
    }]
  })
}
