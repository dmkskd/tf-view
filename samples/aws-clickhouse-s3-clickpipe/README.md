# aws-clickhouse-s3-clickpipe

Applied stack: AWS + ClickHouse Cloud with an S3 ClickPipe, `us-east-1`.

## Resources

- `aws_vpc` 10.43.0.0/16, 2 public subnets, IGW, route table, S3 gateway endpoint
- `aws_instance` t4g.micro, AL2023 arm64, public IP, SSM instance profile, `s3:PutObject` on `events/*`
- `aws_s3_bucket` private, `aws_s3_bucket_notification` `events/*.json` -> `aws_sqs_queue`
- `clickhouse_service` vertical autoscaling, 3 replicas x 8 GiB, idle scaling after 5 min, `ip_access = []`
- `clickhouse_clickpipe` S3, JSONEachRow, continuous, SQS queue, `IAM_ROLE`, managed table `default.events`

## Data path

- EC2 -> `s3://<bucket>/events/<ts>.json` through the S3 gateway endpoint
- S3 `ObjectCreated` -> SQS
- ClickPipe polls SQS, assumes `aws_iam_role.clickpipes` (trust principal = `clickhouse_service.main.iam_role`), reads the object, inserts into `events`
- `aws_s3_object.seed` gives the initial load 2 rows

## Query path

- EC2 -> interface `aws_vpc_endpoint` -> ClickHouse, HTTPS 8443
- Route 53 private zone `<region>.vpce.aws.clickhouse.cloud`, CNAME for `private_dns_hostname`
- `clickhouse_service_private_endpoints_attachment` registers the endpoint ID with the service

## Credentials

- AWS: default credential chain
- ClickHouse: `~/.clickhouse.env` (`CLICKHOUSE_ORG_ID`, `CLICKHOUSE_CLOUD_API_KEY`, `CLICKHOUSE_CLOUD_API_SECRET`), API key role Admin

## Commands

- `just init`
- `just plan`
- `just apply confirm`
- `just produce [n]`: uploads one file with n events (default 100)
- `just check`: row count, latest `ts`, counts per `event_type`
- `just state`: ClickPipe state from ClickHouse Cloud
- `just json`: `plan.json` for tfplanview
- `just destroy confirm`

## Notes

- `ssm.sh` runs stdin on the client through SSM `AWS-RunShellScript`, in `var.region`
- `just check` sends the ClickHouse password in the SSM command parameters
- the ClickPipe validates S3 and SQS access at creation; `time_sleep.clickpipes_iam` waits 20 s for IAM propagation
