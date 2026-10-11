#!/usr/bin/env bash
# A showcase PR for the image settings: opens a demo PR (or continues an open one), pushes review changes
# 1 (delete) and 2 (update in place), then posts the visual plan once per image setting, and releases the
# PR's Atlantis lock so the next demo PR can plan.
# The showcase comments take the plan from the PR's newest report in reports/ (redacted by tfview) and run
# atlantis/report.sh in the Atlantis container once per setting, with a terraform stand-in that prints that plan.
# Atlantis locks the project to the last PR that planned it, until that PR is applied, closed or unlocked.
# Each step waits for Atlantis to finish its plan, and waits for or reports a lock held by another PR.
# Needs the stack running (just up).
# Usage: showcase.sh [PR number]   (default: a new demo PR; a PR number continues that open PR, the newest one)
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
export GH_TOKEN
R=$GH_REPO
ATLANTIS=http://127.0.0.1:4142

# name|settings|title|what to look for (each showcase comment starts with its title, settings and this text)
VARIANTS=(
  "1-png|PLAN_IMAGE=on|PNG screenshot (the default)|The comment shows a PNG screenshot of the report page. The link above the image opens the full report."
  "2-svg-tour|PLAN_IMAGE=svg|SVG with the tour|The image is an SVG. Compared with the PNG of showcase 1, it stays sharp when you zoom in, matches your light or dark theme, and can animate. Changed resources pulse. After 1.8 seconds the view zooms to each change in turn and shows a caption for it. The tour starts with the resources to destroy and visits up to 8 changes. A final card counts the remaining changes and marks them on the diagram."
  "3-svg-tour-tuned|PLAN_IMAGE=svg PLAN_IMAGE_TOUR_STOPS=3 PLAN_IMAGE_TOUR_DELAY=3|SVG tour with 3 stops after 3 seconds|The view zooms to each change in turn, as in showcase 2 (SVG with the tour), with two settings changed. The whole diagram stays on screen for 3 seconds before the tour starts, and the tour visits 3 changes. The final card counts the changes that the tour skipped."
  "4-svg-sections|PLAN_IMAGE=svg PLAN_IMAGE_DETAILS=5|SVG tour with sections|The view zooms to each change in turn, as in showcase 2 (SVG with the tour). Under the image there is a collapsible section for each of the first 5 changes, starting with the resources to destroy. Each section shows a crop of the diagram around the resource, the reason Terraform gives for the action, and the attribute diff."
  "5-svg-replay|PLAN_IMAGE=svg PLAN_IMAGE_STYLE=replay PLAN_IMAGE_DETAILS=5|SVG replay with sections|The image shows the changes in the order an apply makes them. The diagram starts in the prior state, and the changes happen one by one in dependency order. Each step marks one resource on the diagram. A resource to destroy turns grey and is crossed out. A resource to update gets a coloured ring for a moment. A resource to replace disappears and comes back. A new resource appears in its place on the diagram. The band under the diagram names each step, and the image ends on the planned state. Under the image, a collapsible section for each of the first 5 changes shows a crop of the diagram, the reason Terraform gives for the action, and the attribute diff, as in showcase 4 (SVG tour with sections)."
  "6-svg-still|PLAN_IMAGE=svg PLAN_IMAGE_ANIMATION=off PLAN_IMAGE_DETAILS=5|SVG without animation, with sections|The image is the same kind of SVG as in showcase 2 (SVG with the tour), drawn without animation. Changed resources keep a still outline. Under the image, a collapsible section for each of the first 5 changes shows a crop of the diagram, the reason Terraform gives for the action, and the attribute diff, as in showcase 4 (SVG tour with sections)."
  "7-no-html|REPORT_HTML=off PLAN_IMAGE=svg PLAN_IMAGE_STYLE=replay PLAN_IMAGE_DETAILS=5|No HTML report|The comment contains the replay image from showcase 5 (SVG replay with sections) and the collapsible sections for the first 5 changes. The images are attachments of this comment, and GitHub stores them with the access control of the repository. Use this setting where the HTML report must not be published."
)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
newest_pr() {
  gh api "repos/$R/pulls?state=open&sort=created&direction=desc&per_page=30" \
    --jq '[.[] | select(.head.ref | startswith("demo-"))][0].number // empty'
}

# The PRs other than $1 that hold an Atlantis lock, one per line
lock_holders() {  # $1 = our PR ("" for none)
  curl -fsS "$ATLANTIS/api/locks" | jq -r --arg me "$1" '[(.Locks // [])[] | .PullID | select(. != $me)] | unique[]'
}

# Waits until no other PR holds a lock. Atlantis drops a closed PR's lock when it handles the close
# event; an open PR keeps its lock, so that ends the run with instructions.
wait_unlocked() {  # $1 = our PR ("" for none)
  for _ in $(seq 1 12); do
    holders=$(lock_holders "$1") || { echo "cannot read the locks from $ATLANTIS/api/locks"; return 1; }
    [ -z "$holders" ] && return 0
    for h in $holders; do
      if [ "$(gh api "repos/$R/pulls/$h" --jq .state)" = open ]; then
        echo "PR #$h is open and holds the Atlantis lock. Close it, or comment 'atlantis unlock' on it, then run again."
        return 1
      fi
    done
    echo "waiting for Atlantis to release the lock of closed PR(s): $holders"
    sleep 10
  done
  echo "the lock of PR(s) $holders was not released; delete it in the Atlantis UI ($ATLANTIS)"; return 1
}

# Waits for Atlantis to finish the plan asked for at $2 on PR $1. A plan refused because of
# another PR's lock is asked for again once the lock is gone (up to 3 times).
wait_plan() {  # $1 = PR, $2 = since (UTC)
  since=$2 tries=0
  for _ in $(seq 1 90); do
    bodies=$(gh api "repos/$R/issues/$1/comments?since=$since" --jq '.[].body' 2>/dev/null || true)
    if grep -q 'currently locked' <<<"$bodies"; then
      tries=$((tries + 1)); [ "$tries" -le 3 ] || { echo "PR #$1 stays locked"; return 1; }
      wait_unlocked "$1" || return 1
      since=$(now)
      gh pr comment "$1" -R "$R" --body "atlantis plan" >/dev/null
      echo "  asked Atlantis to plan #$1 again"
      continue
    fi
    if grep -qE '^\*\*Plan (Error|Failed)' <<<"$bodies"; then echo "Atlantis could not plan #$1:"; grep -m2 -E 'Plan (Error|Failed)' <<<"$bodies"; return 1; fi
    if grep -q '^Ran Plan' <<<"$bodies"; then echo "  Atlantis planned #$1"; sleep 15; return 0; fi   # its lock on the PR's commands ends after the last comment
    sleep 10
  done
  echo "timed out waiting for Atlantis on #$1"; return 1
}

curl -fs -o /dev/null "$ATLANTIS/healthz" || { echo "Atlantis is not running; run 'just up' first"; exit 1; }

if [ -n "${1:-}" ]; then
  NUM=$1
  [ "$(newest_pr)" = "$NUM" ] || { echo "PR #$NUM is not the newest open demo PR (the review changes go to that one)"; exit 1; }
  wait_unlocked "$NUM"
else
  wait_unlocked ""
  echo "== open a new demo PR"; t=$(now)
  scripts/demo.sh mr-create | tail -2
  NUM=$(newest_pr)
  wait_plan "$NUM" "$t"
fi
# shellcheck source=../../shared/revisions.sh
. ../shared/revisions.sh   # change_def
for n in 1 2; do
  title=$(change_def mr-change-$n | cut -d'|' -f1)
  # demo.sh writes "mr-change-N: <title>" as the commit's first line
  if gh api "repos/$R/pulls/$NUM/commits" --jq '.[].commit.message | split("\n")[0]' | grep -qxF "mr-change-$n: $title"; then
    echo "== review change $n is on #$NUM already"; continue
  fi
  echo "== review change $n on #$NUM"; t=$(now)
  scripts/demo.sh mr-change-$n | tail -1
  wait_plan "$NUM" "$t"
done
# the plan of the PR's last commit (it may still run when the script continues a stopped run)
head_time=$(gh api "repos/$R/pulls/$NUM/commits" --jq 'last | .commit.committer.date')
wait_plan "$NUM" "$head_time"
pr=$(gh api "repos/$R/pulls/$NUM")

# newest first by modification time; the names are report.sh's own (pr<N>-<project>-<time>.html)
# shellcheck disable=SC2010
report=$(ls -t reports/pr"$NUM"-*.html 2>/dev/null | grep -v -- '-showcase-' | head -1 || true)
[ -n "$report" ] || { echo "no report for PR #$NUM in reports/ yet; wait for Atlantis to plan it"; exit 1; }
plan=$(mktemp)
trap 'rm -f "$plan"' EXIT
sed -n 's/.*<script type="application\/json" id="injected-plan">\([^<]*\)<\/script>.*/\1/p' "$report" > "$plan"
jq -e .resource_changes "$plan" >/dev/null || { echo "could not read the plan from $report"; exit 1; }
echo "PR #$NUM, plan from $report: $(jq -r '[.resource_changes[].change.actions | join("/") | select(. != "no-op")]
  | group_by(.) | map("\(length) \(.[0])") | join(", ")' "$plan")"

dc() { docker compose exec -T atlantis "$@"; }
dc true 2>/dev/null || { echo "Atlantis is not running; run 'just up' first"; exit 1; }
dc sh -c 'rm -rf /tmp/showcase && mkdir -p /tmp/showcase/bin /tmp/showcase/work && cat > /tmp/showcase/plan.json' < "$plan"
dc sh -c 'printf "#!/bin/sh\nexec cat /tmp/showcase/plan.json\n" > /tmp/showcase/bin/terraform && chmod +x /tmp/showcase/bin/terraform'

intro=$(mktemp)
{
  echo "### Visual plan showcase"
  echo "The next ${#VARIANTS[@]} comments show the plan of this PR with different image settings."
  echo "Each comment starts with its settings. Set the same values in the Atlantis environment to get the same comment."
  echo "All settings are listed in \`demo/atlantis/shared/lib.sh\`."
  echo
  echo "| Comment | Settings |"
  echo "|---|---|"
  i=0
  for v in "${VARIANTS[@]}"; do
    IFS='|' read -r _ settings title _ <<<"$v"
    i=$((i + 1))
    echo "| $i. $title | \`$settings\` |"
  done
} > "$intro"
gh pr comment "$NUM" -R "$R" --body-file "$intro" >/dev/null
rm -f "$intro"

# Puts the title, the settings and what to look for at the top of the comment report.sh posted
annotate() {  # $1 = number, $2 = name, $3 = settings, $4 = title, $5 = what to look for, $6 = since
  cid=$(gh api "repos/$R/issues/$NUM/comments?since=$6&per_page=100" \
          --jq "[.[] | select(.body | startswith(\"### Visual plan (showcase-$2)\"))] | last | .id // empty")
  [ -n "$cid" ] || { echo "  could not find the comment to annotate"; return 1; }
  old=$(gh api "repos/$R/issues/comments/$cid" --jq .body)
  # shellcheck disable=SC2016  # the backticks are Markdown
  new=$(printf '### Showcase %s/%s: %s\n\n**Settings:** `%s`\n\n**What to look for:** %s\n\n---\n%s\n' \
          "$1" "${#VARIANTS[@]}" "$4" "$3" "$5" "$(printf '%s\n' "$old" | sed '1d')")
  gh api -X PATCH "repos/$R/issues/comments/$cid" -f body="$new" >/dev/null
}

i=0
for v in "${VARIANTS[@]}"; do
  IFS='|' read -r name settings title look <<<"$v"
  i=$((i + 1))
  echo "showcase $i ($name): $settings"
  env_args=()
  for kv in $settings; do env_args+=(-e "$kv"); done
  t=$(now)
  log=$(mktemp)
  docker compose exec -T \
    -e PULL_NUM="$NUM" -e PROJECT_NAME="showcase-$name" -e PLANFILE=showcase -e DIR=/tmp/showcase/work \
    -e HEAD_COMMIT=none -e BASE_REPO_OWNER="${R%%/*}" -e BASE_REPO_NAME="${R##*/}" \
    -e TFVIEW_LLM=false -e REPORT_STRICT=true "${env_args[@]}" \
    atlantis sh -c 'PATH=/tmp/showcase/bin:$PATH; export PATH; exec sh /opt/tfplanview/report.sh' \
    > "$log" 2>&1 || echo "  showcase $i failed"
  sed 's/^/  /' "$log"
  if grep -q 'trying again with PNG' "$log"; then
    look="$look GitHub refused the SVG attachments, so report.sh posted still PNG images instead."
  fi
  rm -f "$log"
  annotate "$i" "$name" "$settings" "$title" "$look" "$t" || true
done

dc rm -rf /tmp/showcase

# The comments stay; the lock goes, so the next demo PR can plan
gh pr comment "$NUM" -R "$R" --body "atlantis unlock" >/dev/null && echo "released the Atlantis lock of #$NUM"
echo "Done: $(jq -r .html_url <<<"$pr")"
