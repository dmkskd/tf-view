# Small stack for the Atlantis demo. Runs against Floci (local AWS emulator), no AWS account needed.
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

# The network is the base (applied once at `just up`). The MR adds the rest by switching these on.
variable "app" {
  description = "EC2 instance and its security group."
  type        = bool
  default     = false
}

variable "bucket" {
  description = "S3 bucket for assets."
  type        = bool
  default     = false
}

variable "messaging" {
  description = "SNS topic and SQS queue."
  type        = bool
  default     = false
}

variable "legacy" {
  description = "Old export bucket that already exists; switching it off deletes it."
  type        = bool
  default     = true
}

variable "env" {
  description = "Environment tag on the VPC; changing it is an in-place update."
  type        = string
  default     = "demo"
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
    ec2 = local.endpoint
    s3  = local.endpoint
    sqs = local.endpoint
    sns = local.endpoint
    iam = local.endpoint
    sts = local.endpoint
    kms = local.endpoint
  }
}

# Base: the network
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "demo", Env = var.env }
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "us-east-1a"
  tags              = { Name = "demo-a" }
}

resource "aws_subnet" "b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "us-east-1b"
  tags              = { Name = "demo-b" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "demo" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "demo-public" }
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "a" {
  subnet_id      = aws_subnet.a.id
  route_table_id = aws_route_table.public.id
}

# Base: a legacy bucket that already exists and that the MR can remove
resource "aws_s3_bucket" "legacy" {
  count  = var.legacy ? 1 : 0
  bucket = "demo-legacy-exports"
  tags   = { Name = "demo-legacy-exports" }
}

# Added by the MR: app
resource "aws_security_group" "app" {
  count  = var.app ? 1 : 0
  name   = "demo-app"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
}

resource "aws_instance" "app" {
  count                  = var.app ? 1 : 0
  ami                    = "ami-12345678"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.a.id
  vpc_security_group_ids = [aws_security_group.app[0].id]
  tags                   = { Name = "demo-app" }
}

# Added by the MR: storage
resource "aws_s3_bucket" "assets" {
  count  = var.bucket ? 1 : 0
  bucket = "demo-assets"
}

# Added by the MR: messaging
resource "aws_sqs_queue" "jobs" {
  count = var.messaging ? 1 : 0
  name  = "demo-jobs"
}

resource "aws_sns_topic" "alerts" {
  count = var.messaging ? 1 : 0
  name  = "demo-alerts"
}
