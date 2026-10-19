#!/bin/sh
# Shared by both flavours' report.sh (mounted at /opt/tfplanview/lib.sh). Source it, then call:
#   render_report PLAN_JSON OUT_HTML LABEL   writes the report; sets $llm (Markdown, empty when there was no review)
#   take_screenshot HTML PNG                 returns 0 when a PNG was written
#   take_svg HTML SVG                        returns 0 when an SVG of the diagram was written (PLAN_IMAGE=svg);
#                                            with PLAN_IMAGE_DETAILS, also writes SVG's name with .details.json
#   details_markdown JSON UPLOAD             prints the per-change sections; UPLOAD FILE prints the file's URL
#   svg_to_png SVG PNG                       a still PNG of an SVG (its picture at rest), for where SVG is refused
#   report_dir                               where to write the report: /reports, or a new temporary folder (REPORT_HTML=off)
#   run_guarded FUNCTION                     runs FUNCTION; its failure is logged, and does not fail the plan
# Settings (all optional), by layer. The defaults give the HTML report and a PNG screenshot.
#  What is published
#   REPORT_HTML=off           no HTML report is published or kept; the comment contains only the image (and sections)
#   PLAN_IMAGE=on             the comment's image: on (PNG screenshot), svg (the diagram as SVG: sharp, light/dark,
#                             animated; PNG if that fails), off (none)
#   PLAN_IMAGE_DETAILS=0      with svg: a collapsible section per change (image crop, attribute diff), for this many (0 to 20)
#  How the SVG moves
#   PLAN_IMAGE_STYLE=tour     tour (zooms to each change in turn) or replay (the changes happen one by one, as in an apply)
#   PLAN_IMAGE_ANIMATION=off  no motion at all; changes keep a still outline
#   PLAN_IMAGE_TOUR=off       no tour or replay; changes keep a pulsing outline
#   PLAN_IMAGE_TOUR_STOPS=8   how many changes the tour visits (0 to 20)
#   PLAN_IMAGE_TOUR_DELAY=0   seconds on the whole diagram before the tour or replay first starts (0 to 60)
#  The HTML report
#   VIEWER_ONLY=off           keep the Load and Samples buttons
#   SHOW_CHANGES=off          do not mark changes on open
#  LLM review
#   TFVIEW_LLM=true           add an LLM review; needs TFVIEW_MODEL (and TFVIEW_ENDPOINT, TFVIEW_API_KEY as the provider needs)
#   TFVIEW_TEMPERATURE=0      sampling temperature of the review, 0 to 2 (read by tfview itself)
#   TFVIEW_TIMEOUT=180        seconds the review may take; after that the plain report is written
#  Failures
#   TFVIEW_NET_TIMEOUT=60     seconds for each network call (GitHub, GitLab) before it is given up
#   REPORT_STRICT=true        a failed report fails the plan step (by default it never does)

# The comment text for a review: one line of facts, then the summary as a quote.
# "@" gets a zero-width space after it, so a model's text cannot mention anyone.
llm_block() {  # $1 = the enriched plan written by `tfview explain --json-out`
  jq -r '
    .annotations.llm_review as $r
    | ($r.metrics // {}) as $m
    | [ "**LLM review**",
        "\($r.model) (\($r.provider))",
        "risk **\($r.risk_level)**",
        (if $m.duration_ms   then "\(($m.duration_ms / 100 | round) / 10) s" else empty end),
        (if $m.total_tokens  then "\($m.total_tokens) tokens (\($m.prompt_tokens // "?") in, \($m.completion_tokens // "?") out)" else empty end)
      ] | join(" · ")
    ,
      "> " + (($r.summary // "") | gsub("@"; "@\u200b") | gsub("\n"; "\n> "))
  ' "$1"
}

# One self-contained HTML file; the binary replaces sensitive values with "(sensitive)".
render_report() {  # $1 = plan json, $2 = output html, $3 = label
  rr_plan=$1 rr_out=$2 rr_review="$1.review"
  set -- --no-open --label "$3"
  [ "${VIEWER_ONLY:-on}" != off ] && set -- "$@" --viewer-only    # no Load/Samples buttons
  [ "${SHOW_CHANGES:-on}" != off ] && set -- "$@" --show-changes  # changes marked on open (and in the screenshot)
  # shellcheck disable=SC2034
  llm=""   # read by the caller

  if [ "${TFVIEW_LLM:-false}" != true ]; then
    timeout -k 5 120 tfview open "$rr_plan" -o "$rr_out" "$@"
  elif [ -z "${TFVIEW_MODEL:-}" ]; then
    echo "TFVIEW_LLM=true but TFVIEW_MODEL is empty, writing the plain report"
    timeout -k 5 120 tfview open "$rr_plan" -o "$rr_out" "$@"
  elif timeout -k 5 "${TFVIEW_TIMEOUT:-180}" tfview explain "$rr_plan" --json-out "$rr_review" -o "$rr_out" "$@"; then
    # shellcheck disable=SC2034
    llm=$(llm_block "$rr_review") || llm=""
  else
    echo "LLM review failed, writing the plain report"
    timeout -k 5 120 tfview open "$rr_plan" -o "$rr_out" "$@"
  fi
  rm -f "$rr_review"   # holds the whole plan, not redacted

  # Node alternative (add nodejs and inject.js to the image, see the Dockerfile):
  # node /opt/tfplanview/inject.js /opt/tfplanview/index.html "$rr_plan" "$label" > "$rr_out"
}

# Optional screenshot of the report (needs Chromium in the image; PLAN_IMAGE=off disables it)
take_screenshot() {  # $1 = html, $2 = png
  [ "${PLAN_IMAGE:-on}" != off ] && command -v chromium >/dev/null || return 1
  timeout -k 5 90 chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
    --window-size=1400,900 --virtual-time-budget=15000 --screenshot="$2" "file://$1" >/dev/null 2>&1 || true
  [ -s "$2" ]
}

# The diagram as SVG: the report drawn with ?export=svg puts the SVG source in one <pre>,
# whose text --dump-dom prints HTML-escaped (only &, <, > and the no-break space).
# With details=N a second <pre> contains the sections as JSON, on one line.
take_svg() {  # $1 = html, $2 = svg
  [ "${PLAN_IMAGE:-on}" = svg ] && command -v chromium >/dev/null || return 1
  nbsp=$(printf '\302\240')
  q="export=svg"
  [ "${PLAN_IMAGE_TOUR:-on}" = off ] && q="$q&tour=0"
  [ "${PLAN_IMAGE_ANIMATION:-on}" = off ] && q="$q&animate=0"
  case ${PLAN_IMAGE_TOUR_STOPS:-} in ''|*[!0-9]*) ;; *) q="$q&tourstops=$PLAN_IMAGE_TOUR_STOPS" ;; esac
  case ${PLAN_IMAGE_STYLE:-} in tour|replay) q="$q&style=$PLAN_IMAGE_STYLE" ;; esac
  case ${PLAN_IMAGE_TOUR_DELAY:-} in ''|*[!0-9.]*) ;; *) q="$q&tourdelay=$PLAN_IMAGE_TOUR_DELAY" ;; esac
  case ${PLAN_IMAGE_DETAILS:-} in ''|*[!0-9]*) ;; *) q="$q&details=$PLAN_IMAGE_DETAILS" ;; esac
  unescape() { sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e "s/&nbsp;/$nbsp/g" -e 's/&amp;/\&/g'; }
  dom="$2.dom"
  timeout -k 5 90 chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --virtual-time-budget=15000 --dump-dom "file://$1?$q" > "$dom" 2>/dev/null || true
  sed -n '/<pre id="tfview-svg">/,/<\/pre>/p' "$dom" \
    | sed -e '1s/.*<pre id="tfview-svg">//' -e '$s/<\/pre>.*//' | unescape > "$2" || true
  if grep -q '<pre id="tfview-details">' "$dom"; then
    grep -o '<pre id="tfview-details">.*' "$dom" | sed -e 's/^<pre id="tfview-details">//' -e 's/<\/pre>.*//' \
      | unescape > "${2%.svg}.details.json" || true
  fi
  rm -f "$dom"
  head -c 4 "$2" 2>/dev/null | grep -q '^<svg'
}

# The sections' Markdown, with each crop uploaded by UPLOAD and its URL in place of @@IMG<n>@@.
# A crop that could not be uploaded is left out of its section.
details_markdown() {  # $1 = details json, $2 = upload function (prints the URL)
  dm_n=$(jq '.files | length' "$1" 2>/dev/null) || return 1
  dm_urls="[]" dm_i=0
  while [ "$dm_i" -lt "$dm_n" ]; do
    dm_f="${1%.json}-$dm_i.svg"
    jq -r ".files[$dm_i].svg" "$1" > "$dm_f"
    dm_u=$("$2" "$dm_f") || dm_u=""
    dm_urls=$(printf '%s' "$dm_urls" | jq -c --arg u "$dm_u" '. + [$u]')
    dm_i=$((dm_i + 1))
  done
  jq -r --argjson u "$dm_urls" '
    reduce range(0; $u | length) as $i (.markdown;
      $u[$i] as $url
      | gsub("!\\[(?<a>[^\\]]*)\\]\\(@@IMG\($i)@@\\)"; if $url == "" then "" else "![\(.a)](\($url))" end))' "$1"
}

# A still PNG of an SVG: sized from its width and height, drawn with reduced motion, so what
# shows is its picture at rest (the overview for the tour, the planned state for the replay).
svg_to_png() {  # $1 = svg, $2 = png
  command -v chromium >/dev/null || return 1
  wh=$(head -c 400 "$1" | sed -n 's/^<svg[^>]* width="\([0-9]*\)" height="\([0-9]*\)".*/\1,\2/p')
  [ -n "$wh" ] || return 1
  timeout -k 5 60 chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
    --force-prefers-reduced-motion --window-size="$wh" --screenshot="$2" "file://$1" >/dev/null 2>&1 || true
  [ -s "$2" ]
}

# With REPORT_HTML=off the report is only an intermediate file: it goes to a temporary folder
# (not /reports, which the demo serves). run_guarded removes it, whatever happened.
# $$ is the script's pid also inside run_guarded's subshell, so both name the same folder.
tmp_report_dir() { echo "${TMPDIR:-/tmp}/tfview-report.$$"; }
report_dir() {
  if [ "${REPORT_HTML:-on}" = off ]; then
    mkdir -m 700 "$(tmp_report_dir)" && tmp_report_dir   # fails if it exists already
  else
    echo /reports
  fi
}

# Network calls give up after TFVIEW_NET_TIMEOUT seconds instead of holding the plan step.
net_timeout() { echo "${TFVIEW_NET_TIMEOUT:-60}"; }

# The terraform binary Atlantis planned with. A stack with a required_version constraint makes
# Atlantis download the newest matching version, which can differ from the one on PATH, and a plan
# file can be read only by the version that wrote it.
tf_bin() {
  tb="${ATLANTIS_DATA_DIR:-$HOME/.atlantis}/bin/terraform${ATLANTIS_TERRAFORM_VERSION:-}"
  if [ -n "${ATLANTIS_TERRAFORM_VERSION:-}" ] && [ -x "$tb" ]; then echo "$tb"; else echo terraform; fi
}

# The report is a courtesy: whatever goes wrong in FUNCTION (a full disk, a GitHub outage, a hung upload)
# is logged with the step it happened in, and the plan step still succeeds. REPORT_STRICT=true makes it fail.
# FUNCTION sets STEP before each step, so the log says where it stopped.
run_guarded() {
  ( set -e
    # shellcheck disable=SC2154  # rc is set inside the trap
    trap 'rc=$?; [ "$rc" -eq 0 ] || echo "tfview report: failed while ${STEP:-starting} (exit $rc)" >&2' EXIT
    "$@" )
  rg_rc=$?
  rm -f "$DIR/plan.json" "$DIR/plan.json.review"   # unredacted; never left behind
  rm -rf "$(tmp_report_dir)"                         # REPORT_HTML=off: the report and its images
  [ "$rg_rc" -eq 0 ] && return 0
  echo "tfview report: no report this time; the plan result is not affected (REPORT_STRICT=true makes this an error)" >&2
  [ "${REPORT_STRICT:-false}" = true ] && return "$rg_rc"
  return 0
}
