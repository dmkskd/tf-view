#!/usr/bin/env bash
# webhook.sh on    point the repo's Atlantis webhook at the smee.io relay channel (creates it, or updates it)
# webhook.sh off   remove it
# Uses your own gh login: the demo token has no permission to manage webhooks.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
gh() { env -u GH_TOKEN gh "$@"; }
ID=$(gh api "repos/${GH_REPO}/hooks" 2>/dev/null | jq -r --arg u "${SMEE_URL}" '[.[] | select(.config.url == $u)][0].id // empty' || true)

case "${1:-}" in
  on)
    URL="${SMEE_URL:?SMEE_URL missing in .env}"
    if [ -n "$ID" ]; then
      gh api -X PATCH "repos/${GH_REPO}/hooks/${ID}" -f "config[url]=$URL" -f 'config[content_type]=json' -f "config[secret]=${GH_WEBHOOK_SECRET}" -F active=true >/dev/null
      echo "webhook updated -> $URL"
    else
      gh api -X POST "repos/${GH_REPO}/hooks" -f name=web -F active=true \
        -f "config[url]=$URL" -f 'config[content_type]=json' -f "config[secret]=${GH_WEBHOOK_SECRET}" \
        -f 'events[]=issue_comment' -f 'events[]=pull_request' -f 'events[]=pull_request_review' -f 'events[]=push' >/dev/null
      echo "webhook created -> $URL"
    fi ;;
  off)
    if [ -n "$ID" ]; then gh api -X DELETE "repos/${GH_REPO}/hooks/${ID}" && echo "webhook removed"; else echo "no webhook to remove"; fi ;;
  *) echo "usage: webhook.sh on | off"; exit 2 ;;
esac
