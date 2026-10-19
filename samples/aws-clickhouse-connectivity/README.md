# aws-clickhouse-connectivity

Applied stack: AWS + ClickHouse Cloud, `us-east-1`.

## Resources

- `aws_vpc` 10.42.0.0/16, 2 public subnets, IGW, route table
- `aws_instance` t4g.micro, AL2023 arm64, SSM instance profile, `aws_eip`
- `aws_s3_bucket` private, object `sample/cities.csv`
- `clickhouse_service` vertical autoscaling, 3 replicas x 8 GiB, idle scaling after 5 min, release channel `default`, backups every 24 h with 24 h retention, MySQL endpoint off, generated password (`password_wo = ""`)

## Connectivity

- EC2 -> ClickHouse
  - `ip_access` = EIP /32, HTTPS 8443, public endpoint
  - `private_link=true`: interface `aws_vpc_endpoint`, SG 8443/9440 from client SG, Route 53 private zone `<region>.vpce.aws.clickhouse.cloud`, `clickhouse_service_private_endpoints_attachment`, `ip_access = []`
  - PrivateLink requires Scale or Enterprise
- ClickHouse -> S3
  - `aws_iam_role.clickhouse_s3` trust principal = `clickhouse_service.main.iam_role`
  - policy: `s3:GetObject`, `s3:ListBucket`, `s3:GetBucketLocation` on the bucket
  - query: `s3(url, 'CSVWithNames', extra_credentials(role_arn = ...))` -> `sts:AssumeRole` -> SigV4 requests to the S3 regional endpoint

## Credentials

- AWS: default credential chain
- ClickHouse: `~/.clickhouse.env`, loaded by `just` (`dotenv-filename`, parent directory search)
  - `CLICKHOUSE_ORG_ID`, `CLICKHOUSE_CLOUD_API_KEY`, `CLICKHOUSE_CLOUD_API_SECRET`
  - API key role: Admin
  - plain `terraform`: `set -a; . ~/.clickhouse.env; set +a`

## Commands

- `just init`
- `just plan [-var ...]`
- `just apply confirm [-var private_link=true]`
- `just check`: SSM `AWS-RunShellScript` on the client, `SELECT version()` + S3 read
- `just json [-var ...]`: `plan.json` for tfplanview
- `just destroy confirm`

## Notes

- `just check` sends the ClickHouse password in the SSM command parameters
- `terraform output -raw clickhouse_password`
- `check.sh` reads the region from `var.region`, not the AWS CLI default
