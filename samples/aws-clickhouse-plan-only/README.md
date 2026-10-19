# AWS + ClickHouse Cloud sample

Terraform project (VPC, RDS, S3, SQS, Kinesis, IAM and ClickHouse Cloud) for
generating the `plan.json` sample. It covers both PrivateLink directions:

- AWS to ClickHouse: an interface endpoint to the service, registered with
  `clickhouse_service_private_endpoints_attachment`, with a Route 53 private
  zone for the service hostname.
- ClickHouse to AWS: a Postgres CDC ClickPipe reaches RDS through an NLB
  endpoint service and `clickhouse_clickpipes_reverse_private_endpoint`.

It also includes S3 (SQS notifications) and Kinesis ClickPipes using an IAM
role, a secondary read-only service, scheduled scaling, an upgrade window, an
API key with a custom role, a Query API endpoint and a saved query.

Both providers use fake credentials. `just plan` makes no API call. Apply is
not supported.

`tools/check-layout.js` and `tools/check-parse.js` include `plan.json`.
Regenerate it with `just json`, then re-record the baselines.
