########################################################################
# A modules-based AWS stack for generating tfplanview sample plans: a local
# network module that wraps the public VPC module (a module inside a module),
# one security group per tier, an ALB, an autoscaling group, an RDS database
# and a for_each module (two worker instances).
#
# Everything is built from public terraform-aws-modules, so the plan
# exercises module addresses, module inputs/outputs and module instances.
#
# PLAN-ONLY BY DEFAULT. With var.plan_only = true (the default), fake
# credentials + skip_* flags mean `terraform plan` never calls AWS, and the
# lookups (AZs, AMIs) are replaced by literals. The only network access is to
# the registries on `terraform init`.
#
# IMPORTANT: if a real terraform.tfstate exists (from `apply
# -var="plan_only=false"`), also pass -refresh=false to a plan_only plan, or it
# will try to refresh real resources with the fake credentials.
#
# Usage (default, safe, no AWS account needed):
#   terraform init
#   terraform plan -refresh=false -out=tfplan
#   terraform show -json tfplan > plan.json
#
# To apply for real (billable: NAT gateway, ALB, RDS, 3 instances):
#   terraform apply -var="plan_only=false"
########################################################################

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "plan_only" {
  description = "true (default): fake credentials, never calls AWS. false: uses your normal AWS credential chain and looks up AZs and AMIs."
  type        = bool
  default     = true
}

variable "staged_changes" {
  description = "false: the baseline. true: a change set on top of an applied baseline (one create, update, replace and delete each)."
  type        = bool
  default     = false
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "name" {
  type    = string
  default = "tfplanview-modules"
}

provider "aws" {
  region                      = var.region
  access_key                  = var.plan_only ? "fake" : null
  secret_key                  = var.plan_only ? "fake" : null
  skip_credentials_validation = var.plan_only
  skip_requesting_account_id  = var.plan_only
  skip_metadata_api_check     = var.plan_only
  skip_region_validation      = var.plan_only
}

# Lookups only exist for a real apply, so plan_only never calls AWS.
data "aws_availability_zones" "available" {
  count = var.plan_only ? 0 : 1
  state = "available"
}

data "aws_ssm_parameter" "al2023" {
  count = var.plan_only ? 0 : 1
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# A different image, used to force a replacement when staged_changes is on.
data "aws_ssm_parameter" "al2" {
  count = var.plan_only ? 0 : 1
  name  = "/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2"
}

locals {
  azs        = var.plan_only ? ["${var.region}a", "${var.region}b"] : slice(one(data.aws_availability_zones.available[*].names), 0, 2)
  ami        = var.plan_only ? "ami-0fef201115eefe936" : one(data.aws_ssm_parameter.al2023[*].value)
  ami_staged = var.plan_only ? "ami-019f95f906c09e357" : one(data.aws_ssm_parameter.al2[*].value)
}

# --- network: a local module wrapping the public VPC module (module in module) ---

module "network" {
  source      = "./modules/network"
  name        = var.name
  cidr        = "10.20.0.0/16"
  azs         = local.azs
  s3_endpoint = !var.staged_changes # retired when staged (delete)
}

# --- one security group per tier, each opening to the tier before it ---

module "alb_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "~> 5.0"

  name   = "${var.name}-alb"
  vpc_id = module.network.vpc_id

  ingress_with_cidr_blocks = [{
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = "0.0.0.0/0"
  }]
  egress_with_cidr_blocks = [{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = "10.20.0.0/16"
  }]
}

module "app_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "~> 5.0"

  name   = "${var.name}-app"
  vpc_id = module.network.vpc_id

  computed_ingress_with_source_security_group_id = [{
    from_port                = 8080
    to_port                  = 8080
    protocol                 = "tcp"
    source_security_group_id = module.alb_sg.security_group_id
  }]
  number_of_computed_ingress_with_source_security_group_id = 1

  # added when staged (create)
  ingress_with_cidr_blocks = var.staged_changes ? [{
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = "10.20.0.0/16"
    description = "SSH from the VPC (added by staged_changes)"
  }] : []
}

module "db_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "~> 5.0"

  name   = "${var.name}-db"
  vpc_id = module.network.vpc_id

  computed_ingress_with_source_security_group_id = [{
    from_port                = 5432
    to_port                  = 5432
    protocol                 = "tcp"
    source_security_group_id = module.app_sg.security_group_id
  }]
  number_of_computed_ingress_with_source_security_group_id = 1
}

# --- load balancer ---

module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "~> 9.0"

  name    = var.name
  vpc_id  = module.network.vpc_id
  subnets = module.network.public_subnets

  create_security_group = false
  security_groups       = [module.alb_sg.security_group_id]

  enable_deletion_protection = false

  listeners = {
    http = {
      port     = 80
      protocol = "HTTP"
      forward  = { target_group_key = "app" }
    }
  }

  target_groups = {
    app = {
      name_prefix       = "app-"
      protocol          = "HTTP"
      port              = 8080
      target_type       = "instance"
      create_attachment = false
    }
  }
}

# --- application tier: launch template and ASG, registered with the ALB ---

module "asg" {
  source  = "terraform-aws-modules/autoscaling/aws"
  version = "~> 7.0"

  name                = "${var.name}-app"
  min_size            = 1
  max_size            = 2
  desired_capacity    = 1
  vpc_zone_identifier = module.network.private_subnets

  image_id      = local.ami
  instance_type = "t3.micro"

  security_groups   = [module.app_sg.security_group_id]
  target_group_arns = [module.alb.target_groups["app"].arn]
}

# --- data tier ---

module "db" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.0"

  identifier = var.name

  engine               = "postgres"
  engine_version       = "16"
  family               = "postgres16"
  major_engine_version = "16"
  instance_class       = "db.t4g.micro"
  allocated_storage    = var.staged_changes ? 30 : 20 # grown when staged (update)

  db_name  = "app"
  username = "app"
  port     = 5432

  manage_master_user_password = true

  # the VPC module already made a subnet group from database_subnets: use it
  # rather than creating a second one with the same subnets
  create_db_subnet_group = false
  db_subnet_group_name   = module.network.database_subnet_group_name
  vpc_security_group_ids = [module.db_sg.security_group_id]

  skip_final_snapshot = true
  deletion_protection = false
}

# --- one module, two instances: batch workers, one per private subnet ---

module "worker" {
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "~> 5.0"

  for_each = { a = 0, b = 1 }

  name = "${var.name}-worker-${each.key}"
  # staged: worker "a" is resized (update), worker "b" gets a new image (replace)
  ami                    = var.staged_changes && each.key == "b" ? local.ami_staged : local.ami
  instance_type          = var.staged_changes && each.key == "a" ? "t3.small" : "t3.micro"
  subnet_id              = module.network.private_subnets[each.value]
  vpc_security_group_ids = [module.app_sg.security_group_id]
}

output "alb_dns_name" { value = module.alb.dns_name }
output "db_endpoint" { value = module.db.db_instance_endpoint }
