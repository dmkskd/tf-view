#!/bin/sh
# Atlantis plan step: turn the plan into a visual report and post it on the PR.
# Atlantis provides PLANFILE, DIR, PULL_NUM, PROJECT_NAME, REPO_REL_DIR, HEAD_COMMIT, BASE_REPO_OWNER/NAME.
# The container provides REPORTS_URL and GH_TOKEN; the settings are listed in lib.sh.
# Failure handling: the report is a courtesy, so nothing here fails the plan (see run_guarded in lib.sh).
# shellcheck source=../../shared/lib.sh
# shellcheck disable=SC2329  # the functions run through run_guarded
. /opt/tfplanview/lib.sh

name="pr${PULL_NUM}-${PROJECT_NAME:-default}-$(date +%s).html"
R="${BASE_REPO_OWNER}/${BASE_REPO_NAME}"
link="${REPORTS_URL}/${name}"
gh_() { timeout -k 5 "$(net_timeout)" gh "$@"; }

# Put the report on the gh-pages branch, so its link keeps working once Atlantis is switched off.
publish() {
  b64=$(mktemp) || return 1
  base64 "/reports/$name" | tr -d '\n' > "$b64"
  jq -n --rawfile c "$b64" --arg m "report $name" '{message:$m, content:$c, branch:"gh-pages"}' \
    | gh_ api -X PUT "repos/$R/contents/reports/$name" --input - >/dev/null
  rc=$?
  rm -f "$b64"
  return "$rc"
}

# Make the screenshot a link to the report (a bare image opens full size instead). Cosmetic: may fail.
link_the_screenshot() {  # $1 = the comment's URL
  cid=${1##*issuecomment-}
  body_now=$(gh_ api "repos/$R/issues/comments/$cid" --jq .body) || return 1
  new=$(printf '%s' "$body_now" | sed -E "s|(!\[[^]]*\]\([^)]*\))|[\1]($link)|")
  gh_ api -X PATCH "repos/$R/issues/comments/$cid" -f body="$new" >/dev/null
}

main() {
  STEP="reading the plan"
  terraform show -json "$PLANFILE" > "$DIR/plan.json"

  STEP="rendering the report (and the LLM review, if asked for)"
  render_report "$DIR/plan.json" "/reports/$name" "PR #${PULL_NUM} ${REPO_REL_DIR}"
  rm -f "$DIR/plan.json"

  STEP="publishing the report to gh-pages"
  published=false
  if publish; then
    published=true
    open_line="**[Open the visual plan]($link)**"
  else
    echo "tfview report: could not publish the report; the comment goes without a link" >&2
    open_line="_The report could not be published this time._"
  fi

  STEP="making the screenshot"
  chg=$(git -C "$DIR" log -1 --format=%B "$HEAD_COMMIT" 2>/dev/null | sed 's/^/> /') || chg=""
  png="/reports/${name%.html}.png"
  take_screenshot "/reports/$name" "$png" && attach="$png" || attach=""

  STEP="posting the comment"
  body=$(mktemp)
  printf '### Visual plan (%s)\n%s\n\n%s\n\n%s\n' "${PROJECT_NAME:-default}" "$chg" "$open_line" "$llm" > "$body"
  # gh's own exit status must not be hidden by a pipe: capture first, then take the last line
  out=$(gh_ pr comment "$PULL_NUM" -R "$R" --body-file "$body" ${attach:+--attach "$attach"}) || { rm -f "$body"; return 1; }
  rm -f "$body"
  comment_url=$(printf '%s\n' "$out" | tail -1)

  STEP="linking the screenshot"
  if [ -n "$attach" ] && [ "$published" = true ]; then
    link_the_screenshot "$comment_url" || echo "tfview report: could not link the screenshot to the report" >&2
  fi
  echo "Visual plan: $link"
}

run_guarded main
exit $?
