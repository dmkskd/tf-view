# The demo MR and its numbered changes (sourced by the GitLab and GitHub demo.sh).
# change_def <command> -> "commit title|tfvars key|value|what it does"; each change builds on the previous ones.
# The base (network + a legacy bucket) is applied at `just up`; the MR builds on it and deletes the legacy bucket and updates the VPC tag early on.
change_def() {
  case "$1" in
    mr-create)   echo 'Add the app (EC2 instance and security group)|app|true|Switches on the app: one EC2 instance and its security group, inside the existing network.' ;;
    mr-change-1) echo 'Remove the legacy export bucket|legacy|false|Review feedback: the old demo-legacy-exports bucket is no longer used, so this deletes it.' ;;
    mr-change-2) echo 'Tag the stack for staging|env|"staging"|Review feedback: this environment is staging, so this changes the Env tag on the existing VPC (an in-place update).' ;;
    mr-change-3) echo 'Add an S3 bucket for assets|bucket|true|Review feedback: the app needs somewhere to keep assets, so this adds an S3 bucket.' ;;
    mr-change-4) echo 'Add messaging (SNS topic and SQS queue)|messaging|true|Review feedback: add an alerts topic and a jobs queue.' ;;
    *) return 1 ;;
  esac
}
