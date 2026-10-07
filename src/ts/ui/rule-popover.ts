import { $, html, raw, type SafeHtml } from "../core/util.js";
import { ruleSetFor, describeRules, describeRule, ruleHoverRow } from "../core/rules.js";
import { sameVal, matchRules } from "../core/diff.js";
import { attrKind } from "../core/schema.js";
import { icoSvg } from "./diagram.js";
import { state } from "../core/state.js";
import { PlanResource, RuleListSpec, RuleListDirection } from "../types/index.js";

/* ------------------------------------------------------------------
   Rule preview. Security groups and network ACLs are the two things you
   most often want to read without opening anything, so hovering one
   shows its rules as direction, port, protocol and peer.

   Every other resource gets a smaller preview: a curated handful of its
   attributes (REG[type].preview, per provider catalog), not a full dump
   — the detail pane already does the full dump on click. Sensitive
   attributes are never shown here. A resource with no preview list, or
   whose preview attributes are all empty, gets no popover at all.
   ------------------------------------------------------------------ */

var popEl: HTMLElement | null = $("rulePop"), popTimer: any = null, popAddr: string | null = null;

function popRuleLines(r: PlanResource, set: RuleListSpec, d: RuleListDirection): string {
  var after = (r.attrs || {})[d.attr];
  var before = (r.before || {})[d.attr];
  var none = html`<div class="rp-none">no ${d.attr} rules</div>`.toString();
  /* Topology shows the rules as they will be; only Changes marks the diff,
     so the card matches whichever mode the diagram is in */
  var changed = state.opts.mode === "changes" &&
                r.action !== "create" && r.action !== "no-op" &&
                Array.isArray(before) && !sameVal(before, after);

  var out: string;
  if (changed){
    out = matchRules(before, after, attrKind(r.type, d.attr), r)
            .map(function(m: any){ return ruleHoverRow(describeRule(r, m.rule), d.inbound, set.ordered, m.mark); }).join("");
  } else {
    var entries = Array.isArray(after) ? after : [];
    if (!entries.length) return none;
    out = describeRules(r, set, entries)
            .map(function(t){ return ruleHoverRow(t, d.inbound, set.ordered, ""); }).join("");
  }
  if (!out) return none;
  if (set.implicit) out += ruleHoverRow(set.implicit, d.inbound, false, "");
  return out;
}

/* One row per key in spec.preview that resolves to something worth
   showing: a non-empty known value, or "known after apply" when the
   plan cannot resolve it yet. Sensitive attributes are dropped. A key
   already shown as the tile's subtitle (spec.sub, e.g. "postgres") is
   still repeated here — the hover card should be a self-contained
   summary, not rely on the tile's small print already being visible. */
function formatAttrItem(item: any): string {
  if (item && typeof item === "object") {
    return Object.entries(item).map(function(pair){ return pair[0] + ": " + pair[1]; }).join(", ");
  }
  return String(item);
}

function attrPreviewVal(v: any): string | null {
  if (Array.isArray(v)){
    if (!v.length) return null;
    var s = v.slice(0, 3).map(formatAttrItem).join("; ");
    return v.length > 3 ? s + " \u2026" : s;
  }
  if (v && typeof v === "object") {
    var strObj = formatAttrItem(v);
    return strObj.length > 64 ? strObj.slice(0, 64) + "\u2026" : strObj;
  }
  var str = String(v);
  return str.length > 64 ? str.slice(0, 64) + "\u2026" : str;
}

function attrPreviewRows(r: PlanResource): SafeHtml {
  var keys = (r.spec && r.spec.preview) || [];
  var rows = keys.map(function(k: string){
    if (r.sensitive && (r.sensitive as any)[k]) return null;
    var known = r.unknown && (r.unknown as any)[k] === true;
    var text = known ? "known after apply" : attrPreviewVal(r.attrs ? r.attrs[k] : undefined);
    if (text === null || text === undefined || text === "") return null;
    return html`
      <div class="rp-attr">
        <span class="rp-k">${k.replace(/_/g, " ")}</span>
        <span class="rp-v${known ? " unknown" : ""}">${text}</span>
      </div>
    `;
  });
  return html`${rows}`;
}

function hasPreview(r: PlanResource | null | undefined): boolean {
  if (!r) return false;
  if (state.opts.showLlm !== false && r.llmInsight) return true;
  if (ruleSetFor(r)) return true;
  return !!attrPreviewRows(r).value;
}

function showRulePop(addr: string, x: number, y: number): void {
  if (!popEl) popEl = $("rulePop");
  if (!popEl) return;
  var r = state.model && state.model.byAddr[addr];
  if (!r) return;
  var set = ruleSetFor(r);

  var body: SafeHtml = html``;
  if (set){
    var rs = set;
    body = html`
      ${rs.directions.map(function(d: RuleListDirection){
        return html`
          <div class="rp-dir">${d.inbound ? "inbound" : "outbound"}</div>
          ${raw(popRuleLines(r!, rs, d))}`;
      })}
      <div class="rp-foot">${rs.note}</div>
    `;
  } else {
    var rows = attrPreviewRows(r);
    if (rows.value) {
      body = html`<div class="rp-attrs">${rows}</div>`;
    }
  }

  var llmSection: SafeHtml = html``;
  if (state.opts.showLlm !== false && r.llmInsight) {
    var ins = r.llmInsight;
    llmSection = html`
      <div class="rp-llm" data-risk="${ins.risk || ""}">
        <div class="rp-llm-head">
          <span class="llm-risk-badge" data-risk="${ins.risk || ""}">${ins.risk || ""}</span>
          ${ins.badge ? html`<span class="rp-llm-badge">${ins.badge}</span>` : ""}
          ${ins.irreversible ? html`<span class="llm-irreversible-pill">Irreversible</span>` : ""}
        </div>
        ${ins.note ? html`<div class="rp-llm-note">${ins.note}</div>` : ""}
      </div>
    `;
  }

  if (!llmSection.value && !body.value && !set) return;

  popEl.innerHTML = html`
    <div class="rp-title">
      ${icoSvg(r.spec, 14)}
      ${set ? set.name : ((r.spec && r.spec.label) || r.type)}
      <b>${r.name}</b>
    </div>
    ${llmSection}
    ${body}
  `.toString();

  popEl.hidden = false;
  var w = popEl.offsetWidth, hh = popEl.offsetHeight;
  popEl.style.left = Math.min(x + 14, window.innerWidth  - w - 8) + "px";
  popEl.style.top  = Math.min(y + 14, window.innerHeight - hh - 8) + "px";
  popAddr = addr;
}

function hideRulePop(): void {
  clearTimeout(popTimer);
  if (!popEl) popEl = $("rulePop");
  if (popEl) popEl.hidden = true;
  popAddr = null;
}

(function wireRulePop(): void {
  var wrap = $("canvasWrap");
  if (!wrap) return;
  wrap.addEventListener("mousemove", function(e: MouseEvent){
    var target = e.target as HTMLElement | null;
    var el = target && target.closest ? (target.closest("[data-addr]") as HTMLElement) : null;
    var addr = el ? el.dataset.addr : null;
    var r = addr && state.model ? state.model.byAddr[addr] : null;
    var wants = hasPreview(r);

    if (!wants){ if (popAddr) hideRulePop(); clearTimeout(popTimer); return; }
    if (addr === popAddr) return;

    clearTimeout(popTimer);
    var x = e.clientX, y = e.clientY;
    popTimer = setTimeout(function(){ if (addr) showRulePop(addr, x, y); }, 280);
  });
  wrap.addEventListener("mouseleave", hideRulePop);
  wrap.addEventListener("pointerdown", hideRulePop);
  wrap.addEventListener("scroll", hideRulePop);
})();

export { popEl, popRuleLines, showRulePop, hideRulePop };

