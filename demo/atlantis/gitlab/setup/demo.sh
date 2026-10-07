#!/usr/bin/env bash
# Drives the demo merge request. Atlantis autoplans every push and comments with a visual-plan link,
# so the MR evolves the way a reviewed one does.
set -euo pipefail

usage() { cat <<'U'
usage: just <command>
  mr-create     open the MR: adds the app (EC2 instance + security group)
  mr-change-1   review change 1: delete the legacy bucket
  mr-change-2   review change 2: update the VPC's Env tag (in place)
  mr-change-3   review change 3: add an S3 bucket
  mr-change-4   review change 4: add messaging (SNS topic + SQS queue)
  status        show the open MR and its commits
  apply         (optional) comment `atlantis apply` on the open MR
  merge         (optional) merge the open MR
U
}
cmd=${1:-}; [ -n "$cmd" ] || { usage; exit 2; }
shift || true

. /shared/atlantis.env
. /revisions.sh   # change_def (shared/revisions.sh)
GL=http://localhost:8929/api/v4
api() { curl -fsS -H "PRIVATE-TOKEN: $ATLANTIS_GITLAB_TOKEN" "$@"; }
P="$GL/projects/root%2Fdemo-infra"
FILE=infra/extra.auto.tfvars

commit() { # branch start_branch message content
  local act=create
  api "$P/repository/files/$(jq -rn --arg f "$FILE" '$f|@uri')?ref=$2" >/dev/null 2>&1 && act=update
  api -X POST "$P/repository/commits" -H 'Content-Type: application/json' -d "$(jq -n --arg b "$1" --arg s "$2" --arg t "$3" --arg a "$act" --arg f "$FILE" --arg c "$4" '{
    branch: $b, start_branch: $s, commit_message: $t,
    actions: [{action: $a, file_path: $f, content: $c}]}')" >/dev/null
}

# Sets mr (json), BR and IID from the newest open demo MR.
open_mr() {
  mr=$(api "$P/merge_requests?state=opened&order_by=created_at&sort=desc&per_page=20" \
    | jq -c '[.[] | select(.source_branch | startswith("demo-"))][0] // empty')
  [ -n "$mr" ] || { echo "no open demo MR; run 'just mr-create' first"; exit 1; }
  BR=$(jq -r .source_branch <<<"$mr"); IID=$(jq -r .iid <<<"$mr")
}

# Sets one key in the tfvars file on a branch and commits it.
set_var() { # branch start_branch message key value
  local cur
  cur=$(api "$P/repository/files/$(jq -rn --arg f "$FILE" '$f|@uri')/raw?ref=$2" 2>/dev/null || true)
  commit "$1" "$2" "$3" "$(grep -v "^$4 " <<<"$cur" || true)"$'\n'"$4 = $5"$'\n'
}

case "$cmd" in
  mr-create)
    IFS='|' read -r msg key val body <<<"$(change_def mr-create)"
    BR="demo-$(date +%s)"
    set_var "$BR" main "$msg"$'\n\n'"$body" "$key" "$val"
    api -X POST "$P/merge_requests" -d source_branch="$BR" -d target_branch=main -d title="$msg" --data-urlencode "description=$body" | jq -r '"MR: " + .web_url'
    echo "Atlantis should comment within ~1 min."
    ;;
  mr-change-1|mr-change-2|mr-change-3|mr-change-4)
    open_mr
    IFS='|' read -r msg key val body <<<"$(change_def "$cmd")"
    set_var "$BR" "$BR" "$msg"$'\n\n'"$body" "$key" "$val"
    echo "Pushed to $(jq -r .web_url <<<"$mr"): $msg"
    ;;
  status)
    open_mr
    jq -r '"!\(.iid) \(.title)\n\(.web_url)"' <<<"$mr"
    api "$P/repository/compare?from=main&to=$BR" | jq -r '.commits[] | "  - " + .title'
    ;;
  apply)
    open_mr
    api -X POST "$P/merge_requests/$IID/notes" --data-urlencode "body=atlantis apply" >/dev/null
    echo "Commented 'atlantis apply' on !$IID"
    ;;
  merge)
    open_mr
    api -X PUT "$P/merge_requests/$IID/merge" >/dev/null && echo "Merged !$IID"
    ;;
  *) usage; exit 2 ;;
esac
