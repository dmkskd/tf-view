#!/bin/sh
# Atlantis plan step: turn the plan into a visual report and post it on the MR.
# Atlantis provides PLANFILE, DIR, PULL_NUM, PROJECT_NAME, REPO_REL_DIR, HEAD_COMMIT, BASE_REPO_OWNER/NAME.
# The container provides REPORTS_URL and ATLANTIS_GITLAB_TOKEN; the settings are listed in lib.sh.
# Failure handling: the report is a courtesy, so nothing here fails the plan (see run_guarded in lib.sh).
# shellcheck source=../../shared/lib.sh
# shellcheck disable=SC2329  # the functions run through run_guarded
. /opt/tfplanview/lib.sh

name="mr${PULL_NUM}-${PROJECT_NAME:-default}-$(date +%s).html"
GL=http://localhost:8929/api/v4/projects/${BASE_REPO_OWNER}%2F${BASE_REPO_NAME}
AUTH="PRIVATE-TOKEN: ${ATLANTIS_GITLAB_TOKEN}"
link="${REPORTS_URL}/${name}"

# Upload a file to the project; prints GitLab's JSON answer
upload() {  # $1 = file
  timeout -k 5 "$(net_timeout)" curl -fsS --connect-timeout 10 -H "$AUTH" -F "file=@$1" "$GL/uploads"
}

main() {
  STEP="reading the plan"
  terraform show -json "$PLANFILE" > "$DIR/plan.json"

  STEP="rendering the report (and the LLM review, if asked for)"
  render_report "$DIR/plan.json" "/reports/$name" "MR !${PULL_NUM} ${REPO_REL_DIR}"
  rm -f "$DIR/plan.json"

  # Store the HTML in GitLab itself (GitLab never renders it, but it is kept with the MR)
  STEP="uploading the report"
  archived=""
  if resp=$(upload "/reports/$name") && md=$(printf '%s' "$resp" | jq -r .markdown); then
    archived="Archived copy stored in GitLab (downloads, GitLab never renders HTML): ${md}"
  else
    echo "tfview report: could not upload the report to GitLab" >&2
  fi

  STEP="making the screenshot"
  chg=$(git -C "$DIR" log -1 --format=%B "$HEAD_COMMIT" 2>/dev/null | sed 's/^/> /') || chg=""
  shot=""
  png="/reports/${name%.html}.png"
  if take_screenshot "/reports/$name" "$png"; then
    if resp=$(upload "$png") && img=$(printf '%s' "$resp" | jq -r .url); then
      shot="[![Visual plan](${img})]($link)"
    else
      echo "tfview report: could not upload the screenshot" >&2
    fi
  fi

  # Atlantis folds step output into its collapsed plan comment, so this is a separate MR comment
  STEP="posting the comment"
  timeout -k 5 "$(net_timeout)" curl -fsS --connect-timeout 10 -H "$AUTH" -X POST "$GL/merge_requests/${PULL_NUM}/notes" \
    --data-urlencode "body=### Visual plan (${PROJECT_NAME:-default})
${chg}

**[Open the visual plan in a new tab](${link})**

${llm}

${shot}

${archived}" >/dev/null
  echo "Visual plan: $link"
}

run_guarded main
exit $?
