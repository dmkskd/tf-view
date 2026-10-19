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

# Put a file of the report on the gh-pages branch, so its link keeps working once Atlantis is switched off.
publish() {  # $1 = file under /reports
  f=${1##*/}
  b64=$(mktemp) || return 1
  base64 "$1" | tr -d '\n' > "$b64"
  jq -n --rawfile c "$b64" --arg m "report $f" '{message:$m, content:$c, branch:"gh-pages"}' \
    | gh_ api -X PUT "repos/$R/contents/reports/$f" --input - >/dev/null
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

# For details_markdown: put a crop on gh-pages next to the report and print its URL
publish_url() {  # $1 = file under /reports
  publish "$1" && printf '%s/%s\n' "$REPORTS_URL" "${1##*/}"
}

# For details_markdown with REPORT_HTML=off: the crop is attached to the comment, which refers to it as ./name
attach_ref() {  # $1 = file
  printf './%s\n' "${1##*/}"
}

# Posts the comment from DIR, attaching the given files (named as the body refers to them, ./name).
# If GitHub refuses the SVGs, posts again with still PNGs of them.
post_comment() {  # $1 = dir, $2 = body file, then the files to attach
  pc_dir=$1 pc_body=$2; shift 2
  pc_files="$*"
  set --
  for f in $pc_files; do set -- "$@" --attach "./$f"; done
  if out=$(cd "$pc_dir" && gh_ pr comment "$PULL_NUM" -R "$R" --body-file "$pc_body" "$@"); then
    printf '%s\n' "$out"; return 0
  fi
  case " $pc_files" in *.svg*) ;; *) return 1 ;; esac
  echo "tfview report: the comment with SVG attachments was refused; trying again with PNG" >&2
  set --
  for f in $pc_files; do
    case $f in
      *.svg) svg_to_png "$pc_dir/$f" "$pc_dir/${f%.svg}.png" || return 1; set -- "$@" --attach "./${f%.svg}.png" ;;
      *) set -- "$@" --attach "./$f" ;;
    esac
  done
  sed 's/\.svg)/.png)/g' "$pc_body" > "$pc_body.png" && mv "$pc_body.png" "$pc_body"
  out=$(cd "$pc_dir" && gh_ pr comment "$PULL_NUM" -R "$R" --body-file "$pc_body" "$@") || return 1
  printf '%s\n' "$out"
}

main() {
  # REPORT_HTML=off: the report is drawn in a temporary folder, only to make the images (run_guarded removes it)
  out_dir=$(report_dir) || return 1
  keep_html=true; [ "${REPORT_HTML:-on}" = off ] && keep_html=false
  html="$out_dir/$name"

  STEP="reading the plan"
  "$(tf_bin)" show -json "$PLANFILE" > "$DIR/plan.json"

  STEP="rendering the report (and the LLM review, if asked for)"
  render_report "$DIR/plan.json" "$html" "PR #${PULL_NUM} ${REPO_REL_DIR}"
  rm -f "$DIR/plan.json"

  published=false open_line=""
  if [ "$keep_html" = true ]; then
    STEP="publishing the report to gh-pages"
    if publish "$html"; then
      published=true
      open_line="**[Open the visual plan]($link)**"
    else
      echo "tfview report: could not publish the report; the comment goes without a link" >&2
      open_line="_The report could not be published this time._"
    fi
  fi

  STEP="making the image"
  chg=$(git -C "$DIR" log -1 --format=%B "$HEAD_COMMIT" 2>/dev/null | sed 's/^/> /') || chg=""
  # With the report on gh-pages: the SVG goes next to it (GitHub shows it through its image proxy).
  # With REPORT_HTML=off: the SVG and the crops are attached to the comment.
  # Otherwise a PNG of the report, attached.
  svg="$out_dir/${name%.html}.svg" svg_line="" attach="" details_md=""
  if [ "$published" = true ] && take_svg "$html" "$svg" && publish "$svg"; then
    svg_line="[![Visual plan](${REPORTS_URL}/${svg##*/})]($link)"
    if [ -s "${svg%.svg}.details.json" ]; then
      STEP="publishing the per-change sections"
      details_md=$(details_markdown "${svg%.svg}.details.json" publish_url) || details_md=""
    fi
  elif [ "$keep_html" = false ] && take_svg "$html" "$svg"; then
    svg_line="![Visual plan](./${svg##*/})"
    attach="${svg##*/}"
    if [ -s "${svg%.svg}.details.json" ]; then
      details_md=$(details_markdown "${svg%.svg}.details.json" attach_ref) || details_md=""
      for f in "${svg%.svg}".details-*.svg; do [ -f "$f" ] && attach="$attach ${f##*/}"; done
    fi
  else
    png="$out_dir/${name%.html}.png"
    take_screenshot "$html" "$png" && attach="${png##*/}"
  fi

  STEP="posting the comment"
  body=$(mktemp)
  printf '### Visual plan (%s)\n%s\n\n%s\n\n%s\n\n%s\n\n%s\n' "${PROJECT_NAME:-default}" "$chg" "$open_line" "$llm" "$svg_line" "$details_md" \
    | sed '/^$/N;/^\n$/D' > "$body"   # the parts left empty leave one blank line, not several
  # word splitting of $attach is intended: file names are ours, without spaces
  # shellcheck disable=SC2086
  out=$(post_comment "$out_dir" "$body" $attach) || { rm -f "$body"; return 1; }
  rm -f "$body"
  comment_url=$(printf '%s\n' "$out" | tail -1)

  STEP="linking the screenshot"
  if [ -n "$attach" ] && [ -z "$svg_line" ] && [ "$published" = true ]; then
    link_the_screenshot "$comment_url" || echo "tfview report: could not link the screenshot to the report" >&2
  fi
  if [ "$published" = true ]; then echo "Visual plan: $link"; else echo "Visual plan: $comment_url"; fi
}

run_guarded main
exit $?
