#!/usr/bin/env bash
# Runs two queries from the EC2 client through SSM:
#   1. SELECT version()          (AWS -> ClickHouse)
#   2. read the CSV from S3      (ClickHouse -> AWS, IAM role)
set -euo pipefail

# The stack's region, not the AWS CLI default.
export AWS_REGION=$(echo var.region | terraform console | tr -d '"')

instance=$(terraform output -raw client_instance_id)
host=$(terraform output -raw clickhouse_host)
password=$(terraform output -raw clickhouse_password)
s3_url=$(terraform output -raw s3_url)
role=$(terraform output -raw s3_role_arn)

q1="SELECT version()"
q2="SELECT * FROM s3('$s3_url', 'CSVWithNames', extra_credentials(role_arn = '$role')) FORMAT PrettyCompactMonoBlock"

params=$(python3 -c '
import json, shlex, sys
host, password, q1, q2 = sys.argv[1:]
curl = "curl -sS --fail-with-body --user default:%s https://%s:8443/ --data-binary " % (shlex.quote(password), host)
print(json.dumps({"commands": [
    "echo AWS to ClickHouse:", curl + shlex.quote(q1),
    "echo ClickHouse to S3:", curl + shlex.quote(q2),
]}))' "$host" "$password" "$q1" "$q2")

cmd_id=$(aws ssm send-command \
  --instance-ids "$instance" \
  --document-name AWS-RunShellScript \
  --parameters "$params" \
  --query Command.CommandId --output text)

aws ssm wait command-executed --command-id "$cmd_id" --instance-id "$instance" || true
aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
  --query '[Status, StandardOutputContent, StandardErrorContent]' --output text
