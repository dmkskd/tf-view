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

# For details_markdown: upload a crop and print its URL
upload_url() {  # $1 = file
  upload "$1" | jq -r '.url // empty'
}

main() {
  # REPORT_HTML=off: the report is drawn in a temporary folder, only to make the images (run_guarded removes it)
  out_dir=$(report_dir) || return 1
  keep_html=true; [ "${REPORT_HTML:-on}" = off ] && keep_html=false
  html="$out_dir/$name"

  STEP="reading the plan"
  terraform show -json "$PLANFILE" > "$DIR/plan.json"

  STEP="rendering the report (and the LLM review, if asked for)"
  render_report "$DIR/plan.json" "$html" "MR !${PULL_NUM} ${REPO_REL_DIR}"
  rm -f "$DIR/plan.json"

  # Store the HTML in GitLab itself (GitLab never renders it, but it is kept with the MR)
  archived="" open_line=""
  if [ "$keep_html" = true ]; then
    STEP="uploading the report"
    open_line="**[Open the visual plan in a new tab](${link})**"
    if resp=$(upload "$html") && md=$(printf '%s' "$resp" | jq -r .markdown); then
      archived="Archived copy stored in GitLab (downloads, GitLab never renders HTML): ${md}"
    else
      echo "tfview report: could not upload the report to GitLab" >&2
    fi
  fi

  STEP="making the image"
  chg=$(git -C "$DIR" log -1 --format=%B "$HEAD_COMMIT" 2>/dev/null | sed 's/^/> /') || chg=""
  shot="" details_md=""
  svg="$out_dir/${name%.html}.svg"
  png="$out_dir/${name%.html}.png"
  # the image links to the report when there is one
  framed() { if [ "$keep_html" = true ]; then printf '[![Visual plan](%s)](%s)' "$1" "$link"; else printf '![Visual plan](%s)' "$1"; fi; }
  if take_svg "$html" "$svg" && resp=$(upload "$svg") && img=$(printf '%s' "$resp" | jq -r .url); then
    shot=$(framed "$img")
    if [ -s "${svg%.svg}.details.json" ]; then
      details_md=$(details_markdown "${svg%.svg}.details.json" upload_url) || details_md=""
    fi
  elif take_screenshot "$html" "$png"; then
    if resp=$(upload "$png") && img=$(printf '%s' "$resp" | jq -r .url); then
      shot=$(framed "$img")
    else
      echo "tfview report: could not upload the screenshot" >&2
    fi
  fi

  # Atlantis folds step output into its collapsed plan comment, so this is a separate MR comment
  STEP="posting the comment"
  timeout -k 5 "$(net_timeout)" curl -fsS --connect-timeout 10 -H "$AUTH" -X POST "$GL/merge_requests/${PULL_NUM}/notes" \
    --data-urlencode "body=### Visual plan (${PROJECT_NAME:-default})
${chg}

${open_line}

${llm}

${shot}

${details_md}

${archived}" >/dev/null
  if [ "$keep_html" = true ]; then echo "Visual plan: $link"; else echo "Visual plan posted on MR !${PULL_NUM}"; fi
}

run_guarded main
exit $?
