# The demo MR and its numbered changes (sourced by the GitLab and GitHub demo.sh).
# change_def <command> -> "commit title|tfvars key|value|what it does"; each change builds on the previous ones.
# The platform (network, load balancer, database, sessions table, a legacy bucket) is applied at `just up`; the MR builds the app on it.
change_def() {
  case "$1" in
    mr-create)   echo 'Add the app tier (IAM role, launch template, auto scaling group)|app|true|Switches on the app tier: an IAM role and instance profile, a launch template and an auto scaling group in the private subnets, attached to the existing load balancer.' ;;
    mr-change-1) echo 'Remove the legacy export bucket|legacy|false|Review feedback: the old demo-legacy-exports bucket is no longer used, so this deletes it.' ;;
    mr-change-2) echo 'Use /health as the health check|health_path|"/health"|Review feedback: the load balancer should probe /health, so this changes the target group health check in place.' ;;
    mr-change-3) echo 'Add asset storage|storage|true|Review feedback: the app needs somewhere to keep assets, so this adds a versioned S3 bucket and lets the app role read it.' ;;
    mr-change-4) echo 'Add messaging (SNS topic and SQS queue)|messaging|true|Review feedback: add an alerts topic and a jobs queue, subscribed to each other.' ;;
    *) return 1 ;;
  esac
}
