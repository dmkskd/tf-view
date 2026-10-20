# aws-clickhouse-s3-clickpipe

Applied stack, `us-east-1`: AWS, a ClickHouse Cloud service with an S3 ClickPipe, and ClickHouse Managed Postgres replicated by a CDC ClickPipe.

## Resources

- `aws_vpc` 10.43.0.0/16, 2 public subnets, IGW, route table, S3 gateway endpoint
- `aws_instance` t4g.micro, AL2023 arm64, public IP, SSM instance profile, `s3:PutObject` on `events/*`
- `aws_s3_bucket` private, `aws_s3_bucket_notification` `events/*.json` -> `aws_sqs_queue`
- `clickhouse_service` vertical autoscaling, 3 replicas x 8 GiB, idle scaling after 5 min, `ip_access = []`
- `clickhouse_clickpipe.events` S3, JSONEachRow, continuous, SQS queue, `IAM_ROLE`, managed table `default.events`
- `clickhouse_postgres_service.app` (beta) `var.pg_size` (default `m6gd.large`, the smallest documented size), Postgres 18, `ha_type = "none"`, password from `random_password.pg`
- `terraform_data.pg_schema` creates `public.orders` with local `psql`
- `clickhouse_clickpipe.orders` Postgres CDC, `public.orders` -> `default.pg_orders_cdc`, CA certificate from `data.clickhouse_postgres_service_ca_certificates`
- `clickhouse_clickpipe_cdc_infrastructure` CDC workers at the minimum, 1 vCPU / 4 GiB
- `var.pg_pipe = false` removes the CDC pipe and the CDC workers

## S3 path

- EC2 -> `s3://<bucket>/events/<ts>.json` through the S3 gateway endpoint
- S3 `ObjectCreated` -> SQS
- the ClickPipe polls SQS, assumes `aws_iam_role.clickpipes` (trust principal `clickhouse_service.main.iam_role`), reads the object and inserts into `events`
- `aws_s3_object.seed` gives the initial load 2 rows

## Postgres path

- EC2 -> Postgres public hostname, 5432, TLS
- CDC ClickPipe: initial load, then inserts, updates and deletes from a logical replication slot (`peerflow_slot_*`) into `pg_orders_cdc`
- `pg_orders_cdc` is ReplacingMergeTree; query it with `FINAL` and `_peerdb_is_deleted = 0`
- `pg_orders_live`: `PostgreSQL` engine table; each query reads Postgres. Created by `just pg-link`, outside the plan

## Query path

- EC2 -> interface `aws_vpc_endpoint` -> ClickHouse, HTTPS 8443
- Route 53 private zone `<region>.vpce.aws.clickhouse.cloud`, CNAME for `private_dns_hostname`
- `clickhouse_service_private_endpoints_attachment` registers the endpoint ID with the service

## Credentials

- AWS: default credential chain
- ClickHouse: `~/.clickhouse.env` (`CLICKHOUSE_ORG_ID`, `CLICKHOUSE_CLOUD_API_KEY`, `CLICKHOUSE_CLOUD_API_SECRET`), API key role Admin
- LLM review: `TFVIEW_MODEL`, `TFVIEW_ENDPOINT`, `TFVIEW_API_KEY`

## Commands

- `just init`
- `just plan`
- `just json`: `plan.json` for tfplanview
- `just explain [model] [scope]`: `tfview explain` on `plan.json`, writes `plan-reviewed.json` (review in `annotations.llm_review`) and `review.html`; `scope` is `changes` (default) or `full`
- `just apply confirm`
- `just produce-s3 [n]`: one S3 file with n events (default 100)
- `just check-s3`: `events` row count, latest `ts`, counts per `event_type`
- `just pg-link`: creates `pg_orders_live`, once after apply
- `just produce-pg [n]`: inserts n orders (default 100), sets 10 `paid` orders to `shipped`
- `just check-pg`: rows, shipped orders and latest order in Postgres (through `pg_orders_live`) and in `pg_orders_cdc`, last sync time
- `just state`: ClickPipe states
- `just destroy confirm`

## Notes

- `apply` needs `psql`, `curl` and `python3` locally
- `time_sleep.clickpipes_iam` waits 20 s for IAM propagation; the S3 ClickPipe checks S3 and SQS access at creation
- `terraform_data.cdc_provisioned` polls the Cloud API until the Postgres pipe is `Running` (up to 15 min). The CDC scaling API returns 404 before that, and the provider's own check passes too early
- the provider sets no IP allowlist or private endpoint on Managed Postgres; the hostname is public, with password and TLS
- `ssm.sh` runs stdin on the client through SSM `AWS-RunShellScript`, in `var.region`
- `check-s3`, `pg-link`, `produce-pg` and `check-pg` pass passwords in the SSM command parameters
- `pg_orders_live` stores the Postgres password in its table definition
- `plan-reviewed.json` contains the whole plan, unredacted
- a paused CDC pipe keeps its replication slot, and Postgres retains WAL until the pipe resumes or is deleted
