#!/bin/sh
# Shared by both flavours' report.sh (mounted at /opt/tfplanview/lib.sh). Source it, then call:
#   render_report PLAN_JSON OUT_HTML LABEL   writes the report; sets $llm (Markdown, empty when there was no review)
#   take_screenshot HTML PNG                 returns 0 when a PNG was written
#   run_guarded FUNCTION                     runs FUNCTION; its failure is logged, and does not fail the plan
# Settings (all optional):
#   TFVIEW_LLM=true      add an LLM review; needs TFVIEW_MODEL (and TFVIEW_ENDPOINT, TFVIEW_API_KEY as the provider needs)
#   TFVIEW_TEMPERATURE=0 sampling temperature of the review, 0 to 2 (read by tfview itself)
#   TFVIEW_TIMEOUT=180   seconds the review may take; after that the plain report is written
#   VIEWER_ONLY=off      keep the Load and Samples buttons      SHOW_CHANGES=off  do not mark changes on open
#   PLAN_IMAGE=off       no screenshot
#   TFVIEW_NET_TIMEOUT=60  seconds for each network call (GitHub, GitLab) before it is given up
#   REPORT_STRICT=true   a failed report fails the plan step (by default it never does)

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

# Network calls give up after TFVIEW_NET_TIMEOUT seconds instead of holding the plan step.
net_timeout() { echo "${TFVIEW_NET_TIMEOUT:-60}"; }

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
  [ "$rg_rc" -eq 0 ] && return 0
  echo "tfview report: no report this time; the plan result is not affected (REPORT_STRICT=true makes this an error)" >&2
  [ "${REPORT_STRICT:-false}" = true ] && return "$rg_rc"
  return 0
}
