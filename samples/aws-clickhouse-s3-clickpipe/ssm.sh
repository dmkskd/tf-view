#!/usr/bin/env bash
# Runs the shell script on stdin on the EC2 client through SSM and prints
# its output. Exits non-zero if the script fails.
set -euo pipefail

# The stack's region, not the AWS CLI default.
export AWS_REGION=$(echo var.region | terraform console | tr -d '"')
instance=$(terraform output -raw client_instance_id)

params=$(python3 -c 'import json, sys; print(json.dumps({"commands": [sys.stdin.read()]}))')
cmd_id=$(aws ssm send-command \
  --instance-ids "$instance" \
  --document-name AWS-RunShellScript \
  --parameters "$params" \
  --query Command.CommandId --output text)

aws ssm wait command-executed --command-id "$cmd_id" --instance-id "$instance" || true
read -r status < <(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" --query Status --output text)
aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text
[ "$status" = Success ]
