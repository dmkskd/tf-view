variable "name" { type = string }
variable "cidr" { type = string }
variable "azs" { type = list(string) }

variable "s3_endpoint" {
  type    = bool
  default = true
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = var.name
  cidr = var.cidr
  azs  = var.azs

  private_subnets  = [for i, _ in var.azs : cidrsubnet(var.cidr, 8, i)]
  public_subnets   = [for i, _ in var.azs : cidrsubnet(var.cidr, 8, i + 10)]
  database_subnets = [for i, _ in var.azs : cidrsubnet(var.cidr, 8, i + 20)]

  enable_nat_gateway = true
  single_nat_gateway = true
}

# Lives in the wrapper and uses what the nested module produced.
resource "aws_vpc_endpoint" "s3" {
  count = var.s3_endpoint ? 1 : 0

  vpc_id          = module.vpc.vpc_id
  service_name    = "com.amazonaws.${data.aws_region.current.name}.s3"
  route_table_ids = module.vpc.private_route_table_ids
}

data "aws_region" "current" {}

output "vpc_id" { value = module.vpc.vpc_id }
output "private_subnets" { value = module.vpc.private_subnets }
output "public_subnets" { value = module.vpc.public_subnets }
output "database_subnets" { value = module.vpc.database_subnets }
output "database_subnet_group_name" { value = module.vpc.database_subnet_group_name }
