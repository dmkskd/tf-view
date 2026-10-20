# The ClickHouse demo MR and its numbered changes (sourced by github/scripts/demo.sh with SHARED=../shared-clickhouse).
# change_def <command> -> "commit title|tfvars key|value|what it does"; each change builds on the previous ones.
# The base stack (VPC, EC2 client, S3 + SQS, S3 ClickPipe, one ClickHouse service over PrivateLink) is applied by `just base confirm`.
# Apart from mr-change-1 (the read-only service, which brings the warehouse), every step changes a base resource.
change_def() {
  case "$1" in
    mr-create)   echo 'Let the writer idle after 15 minutes|writer_idle_minutes|15|The writer stops its compute after 15 idle minutes instead of 5, so short gaps between batches do not pay a wake-up.' ;;
    mr-change-1) echo 'Add a read-only reporting service to the warehouse|reporting|true|Dashboards get their own compute: a read-only service on the writer'"'"'s warehouse (2 x 8 GiB), registered with the existing VPC endpoint and given a private DNS record, so the EC2 client reaches it over PrivateLink.' ;;
    mr-change-2) echo 'Scale the writer to 2 replicas|writer_replicas|2|Review feedback: reads now go to the reporting service, so the writer drops from 3 to 2 replicas (in place).' ;;
    mr-change-3) echo 'Give the EC2 client more memory|client_instance_type|"t4g.small"|The producer runs out of memory on larger batches: t4g.micro to t4g.small (in place, the instance restarts).' ;;
    mr-change-4) echo 'Sort the events table by time only|events_sort_by_type|false|Queries filter by time, not by type: the events ClickPipe recreates its table sorted by ts.' ;;
    mr-change-5) echo 'Remove the seed file|seed|false|The seed file was only for the first load; this deletes it from the bucket.' ;;
    *) return 1 ;;
  esac
}
