#!/usr/bin/env bash
# Opens a merge request; Atlantis autoplans and comments with the visual-plan link.
#   add     (default) adds a second queue: a create
#   change  edits what is already applied: an update, a replace and a destroy (needs `add` applied + merged first)
set -euo pipefail
. /shared/atlantis.env
GL=http://localhost:8929/api/v4
api() { curl -fsS -H "PRIVATE-TOKEN: $ATLANTIS_GITLAB_TOKEN" "$@"; }
P="$GL/projects/root%2Fdemo-infra"
BR="demo-$(date +%s)"
FILE=infra/extra.auto.tfvars

case "${1:-add}" in
  add)    CONTENT=$'extra_queue = true\n';                                              TITLE="Add extra queue" ;;
  change) CONTENT=$'extra_queue = false\nenv = "prod"\nbucket_name = "demo-assets-v2"\n'; TITLE="Tweak the stack" ;;
  *) echo "usage: demo.sh [add|change]"; exit 2 ;;
esac
if api "$P/repository/files/$(jq -rn --arg f "$FILE" '$f|@uri')?ref=main" >/dev/null 2>&1; then ACT=update; else ACT=create; fi

api -X POST "$P/repository/commits" -H 'Content-Type: application/json' -d "$(jq -n --arg b "$BR" --arg t "$TITLE" --arg a "$ACT" --arg f "$FILE" --arg c "$CONTENT" '{
  branch: $b, start_branch: "main", commit_message: $t,
  actions: [{action: $a, file_path: $f, content: $c}]}')" >/dev/null
api -X POST "$P/merge_requests" -d source_branch="$BR" -d target_branch=main -d title="$TITLE" | jq -r '"MR: " + .web_url'
echo "Atlantis should comment within ~1 min. Comment 'atlantis apply' on the MR, then merge it."
