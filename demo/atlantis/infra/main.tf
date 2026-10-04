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

variable "extra_queue" {
  description = "Adds a second queue."
  type        = bool
  default     = false
}

variable "env" {
  description = "Tag value; changing it is an in-place update."
  type        = string
  default     = "demo"
}

variable "bucket_name" {
  description = "Changing it forces the bucket to be replaced."
  type        = string
  default     = "demo-assets"
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

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "demo", Env = var.env }
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "us-east-1a"
}

resource "aws_subnet" "b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "us-east-1b"
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "a" {
  subnet_id      = aws_subnet.a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_instance" "app" {
  ami                    = "ami-12345678"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.a.id
  vpc_security_group_ids = [aws_security_group.app.id]
  tags                   = { Name = "demo-app" }
}

resource "aws_security_group" "app" {
  name   = "demo-app"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = var.bucket_name
}

resource "aws_sqs_queue" "jobs" {
  name = "demo-jobs"
}

resource "aws_sns_topic" "alerts" {
  name = "demo-alerts"
}

resource "aws_sqs_queue" "extra" {
  count = var.extra_queue ? 1 : 0
  name  = "demo-extra"
}
