import { html, raw, escapeHtml, copyText, type SafeHtml } from "../core/util.js";
import type { LlmReview, LlmResourceInsight } from "../types/index.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Formats warning text, making known Terraform resource addresses clickable.
 */
export function linkifyWarning(text: string, knownAddrs: string[]): string {
  if (!knownAddrs.length) {
    return escapeHtml(text);
  }

  // Sort addresses descending by length so longer addresses match first
  var sorted = knownAddrs.slice().sort(function(a: string, b: string) {
    return b.length - a.length;
  });

  // Build single regex with alternation of escaped addresses, optional enclosing backticks
  var pattern = new RegExp("`?(" + sorted.map(escapeRegExp).join("|") + ")`?", "g");

  // Single regex pass over escaped text ensures newly-injected markup is never re-scanned
  return escapeHtml(text).replace(pattern, function(_match: string, addr: string) {
    var safeAddr = escapeHtml(addr);
    return '<a class="llm-goto-link" data-goto="' + safeAddr + '">' + safeAddr + "</a>";
  });
}

var RISK_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * The review's resources, most critical first. The model lists them in any order, so the order is set here:
 * by risk, then irreversible before reversible, then the model's own order (the sort is stable).
 */
export function sortByRisk(entries: [string, LlmResourceInsight][]): [string, LlmResourceInsight][] {
  function rank(e: [string, LlmResourceInsight]): number {
    var r = RISK_RANK[(e[1].risk || "").toUpperCase()];
    return r === undefined ? 4 : r;
  }
  return entries
    .map(function(e: [string, LlmResourceInsight], i: number) { return { e: e, i: i }; })
    .sort(function(a, b) {
      return rank(a.e) - rank(b.e)
        || Number(!!b.e[1].irreversible) - Number(!!a.e[1].irreversible)
        || a.i - b.i;
    })
    .map(function(x) { return x.e; });
}

/**
 * Generates a clean Markdown summary suitable for GitHub/GitLab PR descriptions.
 */
export function generateLlmReviewMarkdown(llm: LlmReview): string {
  var lines: string[] = [];
  lines.push("### Architecture & Risk Review");
  lines.push("**Risk Level:** `" + (llm.risk_level || "UNKNOWN") + "` | **Blast Radius:** " + (llm.blast_radius || "None"));
  if (llm.model) {
    lines.push("**Model:** `" + (llm.provider ? llm.provider + " / " : "") + llm.model + "`");
  }
  lines.push("");

  if (llm.summary) {
    lines.push("#### Summary");
    lines.push(llm.summary);
    lines.push("");
  }

  if (llm.key_warnings && llm.key_warnings.length > 0) {
    lines.push("#### Key Warnings");
    llm.key_warnings.forEach(function(w: string) { lines.push("- " + w); });
    lines.push("");
  }

  var resEntries = llm.resources ? sortByRisk(Object.entries(llm.resources)) : [];
  if (resEntries.length > 0) {
    lines.push("#### Planned Resources Review");
    resEntries.forEach(function(entry: [string, LlmResourceInsight]) {
      var addr = entry[0];
      var insight = entry[1];
      var irrev = insight.irreversible ? " **[IRREVERSIBLE]**" : "";
      lines.push("- `" + addr + "` [" + insight.risk + " - " + insight.badge + "]" + irrev + ": " + insight.note);
    });
    lines.push("");
  }

  if (llm.metrics) {
    var sec = (llm.metrics.duration_ms / 1000).toFixed(2);
    var tokStr = "";
    if (llm.metrics.total_tokens !== null && llm.metrics.total_tokens !== undefined) {
      var inTok = llm.metrics.prompt_tokens ? llm.metrics.prompt_tokens.toLocaleString() + " input, " : "";
      var outTok = llm.metrics.completion_tokens ? llm.metrics.completion_tokens.toLocaleString() + " output" : "";
      tokStr = " \u00b7 " + llm.metrics.total_tokens.toLocaleString() + " tokens (" + inTok + outTok + ")";
    }
    lines.push("*LLM review generated in " + sec + "s" + tokStr + "*");
  }

  return lines.join("\n");
}

/**
 * Builds the HTML card for the top-level Architecture & Risk Review section in the plan metadata drawer.
 */
export function buildPlanLlmReviewHtml(llm: LlmReview): SafeHtml {
  var risk = llm.risk_level || "UNKNOWN";
  var resEntries = llm.resources ? sortByRisk(Object.entries(llm.resources)) : [];
  var knownAddrs = resEntries.map(function(e: [string, LlmResourceInsight]) { return e[0]; });

  var critCount = resEntries.filter(function(e: [string, LlmResourceInsight]) { return (e[1].risk || "").toUpperCase() === "CRITICAL"; }).length;
  var highCount = resEntries.filter(function(e: [string, LlmResourceInsight]) { return (e[1].risk || "").toUpperCase() === "HIGH"; }).length;
  var otherCount = resEntries.length - critCount - highCount;

  var metricsDisplay = "";
  if (llm.metrics) {
    var m = llm.metrics;
    var sec = (m.duration_ms / 1000).toFixed(2);
    var tokens = "";
    if (m.total_tokens !== null && m.total_tokens !== undefined) {
      var inTok = (m.prompt_tokens !== null && m.prompt_tokens !== undefined) ? (m.prompt_tokens.toLocaleString() + " input") : "";
      var outTok = (m.completion_tokens !== null && m.completion_tokens !== undefined) ? (m.completion_tokens.toLocaleString() + " output") : "";
      var details = (inTok && outTok) ? " (" + inTok + ", " + outTok + ")" : "";
      tokens = " \u00b7 " + m.total_tokens.toLocaleString() + " tokens" + details;
    }
    metricsDisplay = "Review time: " + sec + "s" + tokens;
  }

  return html`
    <div class="llm-review-card" data-risk="${risk}">
      <div class="llm-review-header">
        <div class="llm-review-badges">
          <span class="llm-risk-badge" data-risk="${risk}">${risk} RISK</span>
          ${llm.scope && html`<span class="llm-meta-tag">${llm.scope}</span>`}
          ${llm.depth && html`<span class="llm-meta-tag">${llm.depth}</span>`}
        </div>
        <div class="llm-header-actions">
          <span class="llm-model-tag">${llm.provider ? llm.provider + " / " : ""}${llm.model}</span>
          <button type="button" class="llm-copy-pr-btn" id="llmCopyPrBtn" title="Copy review summary as Markdown">
            Copy
          </button>
        </div>
      </div>

      ${llm.summary && html`<div class="llm-review-summary">${llm.summary}</div>`}
      ${llm.blast_radius && html`<div class="llm-blast-radius"><strong>Blast Radius:</strong> ${llm.blast_radius}</div>`}

      ${llm.key_warnings && llm.key_warnings.length > 0 && html`
        <div class="llm-warnings">
          <div class="llm-warnings-title">Warnings (${llm.key_warnings.length})</div>
          <ul class="llm-warnings-list">
            ${llm.key_warnings.map(function(w: string) {
              return html`<li>${raw(linkifyWarning(w, knownAddrs))}</li>`;
            })}
          </ul>
        </div>
      `}

      ${resEntries.length > 0 && html`
        <div class="llm-triage-section">
          <div class="llm-triage-header">
            <span class="llm-triage-title">Resource Risk Triage</span>
            <div class="llm-triage-filters" id="llmTriageFilters">
              <button type="button" class="llm-filter-chip active" data-filter="ALL">All (${resEntries.length})</button>
              ${critCount > 0 && html`<button type="button" class="llm-filter-chip" data-filter="CRITICAL">Crit (${critCount})</button>`}
              ${highCount > 0 && html`<button type="button" class="llm-filter-chip" data-filter="HIGH">High (${highCount})</button>`}
              ${otherCount > 0 && html`<button type="button" class="llm-filter-chip" data-filter="OTHER">Med/Low (${otherCount})</button>`}
            </div>
          </div>
          <div class="llm-triage-list" id="llmTriageList">
            ${resEntries.map(function(entry: [string, LlmResourceInsight]) {
              var addr = entry[0];
              var insight = entry[1];
              var itemRisk = (insight.risk || "UNKNOWN").toUpperCase();
              return html`
                <div class="llm-triage-row" data-risk="${itemRisk}">
                  <div class="llm-triage-top">
                    <a class="llm-triage-addr" data-goto="${addr}" title="Select ${addr} on diagram">${addr}</a>
                    <span class="llm-risk-badge" data-risk="${itemRisk}">${insight.risk}</span>
                  </div>
                  ${(insight.badge || insight.irreversible) && html`
                    <div class="llm-triage-title">
                      ${insight.badge && html`<span class="llm-insight-badge-text">${insight.badge}</span>`}
                      ${insight.irreversible && html`<span class="llm-irreversible-pill">Irreversible</span>`}
                    </div>
                  `}
                  ${insight.note && html`<div class="llm-triage-note">${insight.note}</div>`}
                </div>
              `;
            })}
          </div>
        </div>
      `}

      ${metricsDisplay && html`<div class="llm-metrics-footer">${metricsDisplay}</div>`}
    </div>
  `;
}

/**
 * Builds the HTML card for an individual resource's LLM insight in the inspector drawer.
 */
export function buildResourceLlmInsightHtml(insight: LlmResourceInsight): SafeHtml {
  var risk = insight.risk || "UNKNOWN";
  return html`
    <div class="llm-insight-card" data-risk="${risk}">
      <div class="llm-insight-head">
        <span class="llm-risk-badge" data-risk="${risk}">${risk}</span>
        ${insight.badge && html`<span class="llm-insight-badge-text">${insight.badge}</span>`}
        ${insight.irreversible && html`<span class="llm-irreversible-pill">Irreversible</span>`}
      </div>
      ${insight.note && html`<div class="llm-insight-note">${insight.note}</div>`}
    </div>
  `;
}

/**
 * Builds the compact risk chip rendered on canvas resource tiles.
 */
export function buildTileLlmChipHtml(insight: LlmResourceInsight): SafeHtml {
  var risk = insight.risk || "";
  var title = "Risk: " + risk + (insight.note ? " \u2014 " + insight.note : "");
  return html`
    <span class="llm-chip" data-risk="${risk}" title="${title}">
      ${risk}
    </span>
  `;
}

/**
 * Wires interactivity for the Review card (Copy for PR button, triage filter chips).
 */
export function wireLlmReviewInteractivity(llm: LlmReview): void {
  var copyBtn = document.getElementById("llmCopyPrBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", function() {
      var md = generateLlmReviewMarkdown(llm);
      copyText(md, copyBtn as HTMLElement);
    });
  }

  var filtersContainer = document.getElementById("llmTriageFilters");
  var listContainer = document.getElementById("llmTriageList");
  if (filtersContainer && listContainer) {
    var chips = Array.prototype.slice.call(filtersContainer.querySelectorAll<HTMLButtonElement>(".llm-filter-chip"));
    var rows = Array.prototype.slice.call(listContainer.querySelectorAll<HTMLElement>(".llm-triage-row"));

    chips.forEach(function(chip: HTMLButtonElement) {
      chip.addEventListener("click", function() {
        chips.forEach(function(c: HTMLButtonElement) { c.classList.remove("active"); });
        chip.classList.add("active");

        var filter = chip.dataset.filter || "ALL";
        rows.forEach(function(row: HTMLElement) {
          var rowRisk = row.dataset.risk || "";
          if (filter === "ALL") {
            row.hidden = false;
          } else if (filter === "OTHER") {
            row.hidden = (rowRisk === "CRITICAL" || rowRisk === "HIGH");
          } else {
            row.hidden = (rowRisk !== filter);
          }
        });
      });
    });
  }
}
