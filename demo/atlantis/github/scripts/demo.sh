#!/usr/bin/env bash
# Drives the demo PR through the GitHub API. Atlantis plans every push and comments with the visual plan.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { cat <<'U'
usage: just <command>
  mr-create     open the PR: adds the app (EC2 instance + security group)
  mr-change-1   review change 1: delete the legacy bucket
  mr-change-2   review change 2: update the VPC's Env tag (in place)
  mr-change-3   review change 3: add an S3 bucket
  mr-change-4   review change 4: add messaging (SNS topic + SQS queue)
  status        show the open PR and its commits
  apply         (optional) comment `atlantis apply` on the open PR
  merge         (optional) merge the open PR
U
}
cmd=${1:-}; [ -n "$cmd" ] || { usage; exit 2; }

set -a; . ./.env; set +a
export GH_TOKEN
. ../shared/revisions.sh   # change_def
R=$GH_REPO
FILE=infra/extra.auto.tfvars
b64() { base64 | tr -d '\n'; }

# Sets one key in the tfvars file on a branch and commits it.
set_var() { # branch message key value
  local cur sha new
  cur=$(gh api "repos/$R/contents/$FILE?ref=$1" 2>/dev/null || true)
  sha=$(jq -r '.sha // empty' <<<"$cur" 2>/dev/null || true)
  new=$({ [ -n "$cur" ] && jq -r '.content // empty' <<<"$cur" | base64 --decode 2>/dev/null | grep -v "^$3 " || true; printf '%s = %s\n' "$3" "$4"; })
  jq -n --arg m "$2" --arg b "$1" --arg c "$(printf '%s\n' "$new" | b64)" --arg s "$sha" \
    '{message:$m, branch:$b, content:$c} + (if $s == "" then {} else {sha:$s} end)' \
    | gh api -X PUT "repos/$R/contents/$FILE" --input - >/dev/null
}

# Sets pr (json), BR and NUM from the newest open demo PR.
open_pr() {
  pr=$(gh api "repos/$R/pulls?state=open&sort=created&direction=desc&per_page=30" \
        --jq '[.[] | select(.head.ref | startswith("demo-"))][0] // empty')
  [ -n "$pr" ] || { echo "no open demo PR; run 'just mr-create' first"; exit 1; }
  BR=$(jq -r .head.ref <<<"$pr"); NUM=$(jq -r .number <<<"$pr")
}

case "$cmd" in
  mr-create)
    IFS='|' read -r msg key val body <<<"$(change_def mr-create)"
    BR="demo-$(date +%s)"
    sha=$(gh api "repos/$R/git/ref/heads/main" --jq .object.sha)
    gh api -X POST "repos/$R/git/refs" -f "ref=refs/heads/$BR" -f "sha=$sha" >/dev/null
    set_var "$BR" "$msg"$'\n\n'"$body" "$key" "$val"
    gh api -X POST "repos/$R/pulls" -f "title=$msg" -f "head=$BR" -f base=main -f "body=$body" --jq '"PR: " + .html_url'
    echo "Atlantis should comment within ~1 min."
    ;;
  mr-change-1|mr-change-2|mr-change-3|mr-change-4)
    open_pr
    IFS='|' read -r msg key val body <<<"$(change_def "$cmd")"
    set_var "$BR" "$msg"$'\n\n'"$body" "$key" "$val"
    echo "Pushed to $(jq -r .html_url <<<"$pr"): $msg"
    ;;
  status)
    open_pr
    jq -r '"#\(.number) \(.title)\n\(.html_url)"' <<<"$pr"
    gh api "repos/$R/pulls/$NUM/commits" --jq '.[] | "  - " + (.commit.message | split("\n")[0])'
    ;;
  apply)
    open_pr
    gh pr comment "$NUM" -R "$R" --body "atlantis apply" >/dev/null
    echo "Commented 'atlantis apply' on #$NUM"
    ;;
  merge)
    open_pr
    gh api -X PUT "repos/$R/pulls/$NUM/merge" -f merge_method=merge >/dev/null && echo "Merged #$NUM"
    ;;
  *) usage; exit 2 ;;
esac
