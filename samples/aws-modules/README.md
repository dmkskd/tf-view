# aws-modules sample

A three-tier AWS stack built from **modules**, for generating tfplanview sample
plans that exercise module addresses, module inputs and outputs, nested modules
and `for_each` module instances.

```
just init            # or: terraform init
just plan            # plan-only, offline, safe — writes plan.json
just apply confirm   # apply the baseline for real against AWS
just capture         # capture a real create/update/replace/delete diff into changes-plan.json
just destroy confirm # tear it all down
```

## What's in it

| Module | Source | Notes |
|---|---|---|
| `network` | local `./modules/network` | wraps the public VPC module, so there is a module inside a module (`module.network.module.vpc`) |
| `alb_sg`, `app_sg`, `db_sg` | `terraform-aws-modules/security-group` | one per tier, each opens to the tier before it |
| `alb` | `terraform-aws-modules/alb` | listener and target group |
| `asg` | `terraform-aws-modules/autoscaling` | launch template and ASG, registered with the ALB |
| `db` | `terraform-aws-modules/rds` | PostgreSQL, nested modules inside the module |
| `worker` | `terraform-aws-modules/ec2-instance` | `for_each`: `module.worker["a"]`, `module.worker["b"]` |

About 42 resources.

## Safe by default

`plan_only = true` (the default) uses fake credentials, skips every validation
call and replaces the AZ and AMI lookups with literals, so `terraform plan`
never calls AWS. The only network access is to the registries on `init`.
`just plan` also passes `-refresh=false`, so it works even when a real state
file exists.

`apply`, `destroy` and `capture` need the literal word `confirm` (or
`capture`'s state) and use your normal AWS credentials.

## Cost

A real apply creates a NAT gateway, an ALB, an RDS instance (`db.t4g.micro`)
and three `t3.micro` instances, all billed by the hour — roughly 15 cents an
hour at `eu-west-1` list prices, but check current pricing. The RDS instance
takes several minutes to create. Run `just destroy confirm` when you are done.

## The change set

`just capture` needs the baseline applied. It flips `staged_changes` to
produce a real diff:

| Change | Kind |
|---|---|
| SSH rule added to the app security group module | create |
| RDS storage 20 → 30 GB | update |
| worker `a` resized `t3.micro` → `t3.small` | update |
| worker `b` gets a different image | replace |
| the S3 gateway endpoint in `network` is retired | delete |

Because it is planned against real state, `changes-plan.json` also carries
`prior_state`, which holds the dependency graph Terraform saved at the last
apply. That graph includes links that go through `locals`, which the plan's
`configuration` section cannot show (the public VPC and security-group modules
use `local.vpc_id` and `local.this_sg_id` heavily).
