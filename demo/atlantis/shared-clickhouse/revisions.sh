# The ClickHouse demo MR and its numbered changes (sourced by github/scripts/demo.sh with SHARED=../shared-clickhouse).
# change_def <command> -> "commit title|tfvars key|value|what it does"; each change builds on the previous ones.
# The base stack (VPC, EC2 client, S3 + SQS, ClickHouse service with PrivateLink, S3 ClickPipe) is applied by `just base confirm`.
change_def() {
  case "$1" in
    mr-create)   echo 'Add a read-only reporting service to the warehouse|reporting|true|Dashboards get their own compute: a read-only service on the same warehouse (2 x 8 GiB, idles), registered with the existing VPC endpoint and given a private DNS record, so the EC2 client reaches it over PrivateLink.' ;;
    mr-change-1) echo 'Scale the writer to 2 replicas|writer_replicas|2|Review feedback: reads now go to the reporting service, so the writer drops from 3 to 2 replicas (in place).' ;;
    *) return 1 ;;
  esac
}
