import { escapeHtml, $, html, raw, copyText, type SafeHtml, HtmlSafeString } from "../core/util.js";
import { linkTitle } from "../core/links.js";
import { cliCommands, consoleLink, blockHeight, toolNames } from "../core/registry.js";
import { rulesSection } from "../core/rules.js";
import { hclFor, hclHighlight } from "../core/hcl.js";
import { cfgKey, listRefs, RefRow } from "../core/references.js";
import { modelSnapshot } from "../core/snapshot.js";
import { changeHtml, reasonText, valText, sameVal } from "../core/diff.js";
import { changedKeys, select, applySelection, drawEdges, ACTION_COLOR, icoSvg } from "./diagram.js";
import { kindSource } from "../core/schema.js";
import { state, setSelected, onSelect } from "../core/state.js";
import { buildPlanLlmReviewHtml, buildResourceLlmInsightHtml, wireLlmReviewInteractivity } from "./llm-review.js";
import type { PlanModel, PlanResource, CliCommand, DriftEntry, CheckEntry } from "../types/index.js";

var detailEl = $("detail"), splitEl = $("split");

var SEC_DEFAULT: Record<string, boolean> = {llm:true, llmreview:true, drift:true, checks:true, sections:false, diff:true, deps:true, refby:true, rules:true, hcl:false, cli:false, attrs:false};
var secOpen: Record<string, boolean> = {};
try {
  var saved = localStorage.getItem("tfplanview-sections");
  if (saved) secOpen = JSON.parse(saved) || {};
} catch(e){ secOpen = {}; }

function isOpen(key: string): boolean {
  return (secOpen[key] === undefined) ? !!SEC_DEFAULT[key] : !!secOpen[key];
}

var CHEV = html`<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function sec(key: string, title: string, count: number | string | null | undefined, body: string | SafeHtml): string {
  var openAttr = isOpen(key) ? " open" : "";
  var countHtml = (count !== null && count !== undefined)
    ? html` <span class="cnt">${String(count)}</span>`
    : "";
  return html`
    <details data-sec="${key}"${raw(openAttr)}>
      <summary class="dsec">${title}${countHtml}${CHEV}</summary>
      ${body instanceof HtmlSafeString ? body : raw(body)}
    </details>
  `.toString();
}

var detailSections: any[] = [], saveSections = function(): void {};

function wireSections(): void {
  if (!detailEl) detailEl = $("detail");
  if (!detailEl) return;
  var allSecs = Array.prototype.slice.call(detailEl.querySelectorAll<HTMLDetailsElement>("details[data-sec]"));
  var btn = $("secAll");
  function save(): void {
    try { localStorage.setItem("tfplanview-sections", JSON.stringify(secOpen)); } catch(e){}
  }
  function syncAll(): void {
    if (!btn) return;
    var anyClosed = allSecs.some(function(d: HTMLDetailsElement){ return !d.open; });
    btn.dataset.want = anyClosed ? "open" : "close";
    btn.classList.toggle("open", !anyClosed);
    var lbl = btn.querySelector(".lbl");
    if (lbl) lbl.textContent = anyClosed ? "expand all" : "collapse all";
  }
  allSecs.forEach(function(d: HTMLDetailsElement){
    d.addEventListener("toggle", function(){
      if (d.dataset.sec) secOpen[d.dataset.sec] = d.open;
      save();
      syncAll();
    });
  });
  syncAll();
  if (btn) btn.addEventListener("click", function(){
    if (!btn) return;
    var open = btn.dataset.want === "open";
    allSecs.forEach(function(d: HTMLDetailsElement){
      d.open = open;
      if (d.dataset.sec) secOpen[d.dataset.sec] = open;
    });
    save(); syncAll();
  });
  Array.prototype.slice.call(detailEl.querySelectorAll<HTMLElement>("[data-goto]")).forEach(function(a: HTMLElement){
    a.addEventListener("click", function(){ if (a.dataset.goto) select(a.dataset.goto); });
  });
}

/* Every top-level section of the plan, what this app does with it, and its
   contents. Sections the app reads are open; the rest are listed so nothing
   in the file is silently ignored. */
var SECTION_USE: Record<string, [string, string]> = {
  format_version:      ["read", "checked: only format 1.x is understood"],
  terraform_version:   ["read", "shown in the top bar"],
  timestamp:           ["read", "shown in this panel"],
  applyable:           ["read", "warns when the plan cannot be applied"],
  errored:             ["read", "warns when the plan errored"],
  complete:            ["ignored", "not used"],
  variables:           ["read", "resolves the region"],
  resource_changes:    ["read", "the diagram, the diffs and the text view"],
  configuration:       ["read", "containment, dependencies and the rebuilt HCL"],
  output_changes:      ["read", "listed below"],
  resource_drift:      ["read", "listed below"],
  checks:              ["read", "listed below"],
  planned_values:      ["partial", "only used when resource_changes is missing"],
  prior_state:         ["ignored", "not used"],
  relevant_attributes: ["ignored", "not used"],
  annotations:         ["read", "architecture & risk review, execution metrics"]
};

function sectionRows(rawJson: any): SafeHtml {
  var keys = Object.keys(rawJson || {});
  if (!keys.length) return html`<div class="cli-note">nothing to list</div>`;

  var rows = keys.map(function(k: string){
    var use = SECTION_USE[k] || ["unknown", "not recognised by this build"];
    var size = JSON.stringify(rawJson[k]).length;
    return {k:k, use:use, size:size};
  }).sort(function(a: any, b: any){ return b.size - a.size; });

  return html`
    <div class="sections">
      ${rows.map(function(r: any){
        var body = JSON.stringify(rawJson[r.k], null, 1);
        if (body.length > 40000) body = body.slice(0, 40000) + "\n\u2026 truncated";
        return html`
          <details class="sec-row">
            <summary>
              <span class="nm">${r.k}</span>
              <span class="use ${r.use[0]}" title="${r.use[1]}">${r.use[0]}</span>
              <span class="sz">${(r.size / 1024).toFixed(1)} KB</span>
            </summary>
            <pre class="rawjson">${body}</pre>
          </details>
        `;
      })}
    </div>
  `;
}

function driftRows(d: DriftEntry[]): SafeHtml | null {
  if (!d.length) return null;
  return html`
    <div class="attrs">
      ${d.map(function(x: DriftEntry){
        var before = x.before;
        var after  = x.after;
        var keys = Object.keys(before).concat(Object.keys(after)).filter(function(k: string, i: number, a: string[]){
          return a.indexOf(k) === i && !sameVal(before[k], after[k]);
        });
        return html`
          <div class="attr">
            <span class="k">${x.address}</span>
            <span class="v">
              ${keys.length
                ? `${keys.join(", ")} changed outside terraform`
                : html`<span class="unknown">changed outside terraform</span>`}
            </span>
          </div>
        `;
      })}
    </div>
  `;
}

function checkRows(c: CheckEntry[]): SafeHtml | null {
  if (!c.length) return null;
  return html`
    <div class="attrs">
      ${c.map(function(x: CheckEntry){
        var status = x.status || "unknown";
        return html`
          <div class="attr">
            <span class="k">${x.name}</span>
            <span class="v check-status" data-status="${status}">
              ${status}${x.problems.length ? " \u2014 " + x.problems.join("; ") : ""}
            </span>
          </div>
        `;
      })}
    </div>
  `;
}

function renderPlanInfo(): void {
  const model = state.model;
  if (!model) return;
  setSelected(null);
  applySelection();
  drawEdges();
  if (!splitEl) splitEl = $("split");
  if (splitEl) splitEl.classList.add("has-detail");

  var S: any = model.summary || {};
  var rawBytes = model.rawBytes || 0;
  var rows: [string, string | number][] = [
    ["file", model.source || ""],
    ["size", (rawBytes/1024).toFixed(1) + " KB"],
    ["format_version", model.formatVersion || "\u2014"],
    ["terraform_version", model.tfVersion || "\u2014"],
    ["timestamp", model.timestamp || "\u2014"],
    ["region", model.region || "\u2014"],
    ["resources", model.resources.length],
    ["outputs", model.outputs ? Object.keys(model.outputs).length : 0]
  ];
  if (model.llmReview) {
    rows.push(["llm_model", (model.llmReview.provider ? model.llmReview.provider + " / " : "") + model.llmReview.model]);
  }

  var badgesHtml = ["create","update","replace","delete"].map(function(a: string){
    if (!S[a]) return "";
    return html`<span class="badge badge-action" data-action="${a}">${S[a]} ${a}</span>`;
  });

  var paneHtml = html`
    <div class="dhd">
      <div class="dhd-top file-top">
        <div class="dhd-name">
          <span class="type">loaded file</span>
          <h3>${model.source || ""}</h3>
        </div>
      </div>
      <div class="dhd-foot">
        <div class="badges">${badgesHtml}</div>
      </div>
    </div>
  `.toString() + SEC_MASTER;

  if (model.llmReview) {
    paneHtml += sec("llmreview", "Architecture & Risk Review", model.llmReview.risk_level, buildPlanLlmReviewHtml(model.llmReview));
  }

  var metaHtml = html`
    <div class="attrs">
      ${rows.map(function(kv: [string, string | number]){
        return html`
          <div class="attr">
            <span class="k">${kv[0]}</span>
            <span class="v">${String(kv[1])}</span>
          </div>
        `;
      })}
    </div>
  `.toString();
  paneHtml += sec("planmeta", "Plan metadata", null, metaHtml);

  const outputs = model.outputs;
  if (outputs){
    var outputKeys = Object.keys(outputs).sort();
    var outputsHtml = html`
      <div class="attrs">
        ${outputKeys.map(function(k: string){
          var o = outputs[k];
          var unk = o.afterUnknown;
          var v = unk ? "known after apply" : (o.after !== undefined ? JSON.stringify(o.after) : "\u2014");
          return html`
            <div class="attr">
              <span class="k">${k}</span>
              <span class="v${unk ? " unknown" : ""}">${v}</span>
            </div>
          `;
        })}
      </div>
    `;
    paneHtml += sec("outputs", "Outputs", outputKeys.length, outputsHtml);
  }

  var addrs = html`
    <div class="reflist">
      ${model.resources.map(function(r: PlanResource){
        return html`
          <a data-goto="${r.addr}">
            ${r.addr} <span class="action-text" data-action="${r.action}">${r.action}</span>
          </a>
        `;
      })}
    </div>
  `;
  paneHtml += sec("addrs", "Resources", model.resources.length, addrs);

  var drift = driftRows(model.driftDetails);
  if (drift){
    paneHtml += sec("drift", "Drift", model.driftDetails.length, drift);
  }
  var checks = checkRows(model.checks);
  if (checks){
    paneHtml += sec("checks", "Checks", model.checks.length, checks);
  }

  paneHtml += sec("sections", "Plan sections",
              Object.keys(model.raw || {}).length, sectionRows(model.raw));

  var snap = JSON.stringify(modelSnapshot(model), null, 2);
  paneHtml += sec("model", "Parsed model", model.resources.length,
              html`${note("What the viewer understood, not the file: each resource with its module, action and links, and which links only the saved state supplied. Attribute values are left out.")}
                   ${copyBlock("parsed model", 'data-full="model"', html`<pre class="rawjson">${snap}</pre>`)}`);

  var rawJsonStr = model.raw ? JSON.stringify(model.raw, null, 2) : (model.rawText || "");
  var RAW_CAP = 200000;
  var shown = rawJsonStr.length > RAW_CAP
    ? rawJsonStr.slice(0, RAW_CAP) + "\n\u2026 truncated: " + ((rawJsonStr.length - RAW_CAP) / 1024).toFixed(0) +
      " KB more. Use copy for the whole file."
    : rawJsonStr;
  paneHtml += sec("raw", "Raw JSON", (rawBytes/1024).toFixed(1) + " KB",
              copyBlock("raw JSON", 'data-full="raw"', html`<pre class="rawjson">${shown}</pre>`));

  if (!detailEl) detailEl = $("detail");
  if (detailEl) detailEl.innerHTML = paneHtml;
  wireSections();
  /* these copy the whole text, even where the panel shows only the start of it */
  if (detailEl) Array.prototype.slice.call(detailEl.querySelectorAll<HTMLElement>(".cli-copy[data-full]")).forEach(function(b: HTMLElement){
    b.addEventListener("click", function(){
      copyText(b.dataset.full === "model" ? snap : rawJsonStr, b);
    });
  });
  if (model.llmReview) {
    wireLlmReviewInteractivity(model.llmReview);
  }
}

/* --- detail pane --- */
/* ------------------------------------------------------------------
   Detail pane.

   Sections are data: add an entry to DETAIL_SECTIONS and it appears,
   collapses, remembers its state and joins "expand all" with no other
   change. Each builder returns null to omit its section, or
   {title, count, body}. Give every new key a default in SEC_DEFAULT.
   ------------------------------------------------------------------ */

interface DetailSectionBuilderResult {
  title: string;
  count: number | string | null | undefined;
  body: string | SafeHtml;
}

interface DetailSectionDef {
  key: string;
  build: (r: PlanResource, ctx: any) => DetailSectionBuilderResult | null | undefined;
}

var DETAIL_SECTIONS: DetailSectionDef[] = [
  {key:"llm", build: function(r: PlanResource){
    if (!r.llmInsight) return null;
    return {title:"Risk Assessment", count:r.llmInsight.risk, body:buildResourceLlmInsightHtml(r.llmInsight)};
  }},

  {key:"diff", build: function(r: PlanResource){
    var ch = changeHtml(r);
    return ch && {title:"What changes", count:ch.count, body:ch.body};
  }},

  {key:"deps", build: function(r: PlanResource){
    if (!r.refs.length) return null;
    var rows = listRefs(r.refs, (state.model && state.model.byAddr) || {});
    return {title:"Depends on", count:rows.length, body:addrList(rows)};
  }},

  {key:"refby", build: function(r: PlanResource){
    if (!r.dependents || !r.dependents.length) return null;
    return {title:"Referenced by", count:r.dependents.length,
            body:addrList(r.dependents.map(function(a: string): RefRow { return {addr: a, inPlan: true}; }))};
  }},

  {key:"hcl", build: function(r: PlanResource, ctx: any){
    /* the plan's configuration is the new one: for a destroyed resource it would read as if it survived */
    if (r.action === "delete") return null;
    var model = state.model;
    var hcl = hclFor(r, model && model.cfgByAddr && model.cfgByAddr[cfgKey(r.addr)]);
    if (!hcl) return null;
    ctx.hcl = hcl;
    var body = html`
      <div class="cli">
        ${copyBlock("reconstructed", 'data-hcl="1"', html`<pre class="hcl">${raw(hclHighlight(hcl))}</pre>`)}
      </div>
      ${note("Rebuilt from the plan\u2019s configuration block. Comments and exact interpolation are not in the plan, so values computed from variables are shown resolved with their reference noted.")}
    `;
    return {title:"Terraform block", count:null, body: body};
  }},

  {key:"rules", build: function(r: PlanResource){
    var rl = rulesSection(r);
    return rl && {title:rl.title, count:null, body:rl.body};
  }},

  {key:"cli", build: function(r: PlanResource, ctx: any){
    var model = state.model;
    var cmds = cliCommands(r, model);
    var cliTitle = "Inspect with the " + toolNames(r).cli;
    ctx.cmds = cmds;
    if (!cmds.length){
      return {title:cliTitle, count:0,
              body: note(html`No CLI recipe for <code>${r.type}</code> yet.`)};
    }
    var items = cmds.map(function(c: CliCommand, i: number){
      var cmdFormatted = escapeHtml(c.cmd).replace(/(\s)(--[a-z-]+)/g, '$1<span class="fl">$2</span>');
      return copyBlock(c.label, 'data-cli="' + i + '"', html`<pre class="cli-cmd">${raw(cmdFormatted)}</pre>`);
    });
    var body = html`
      <div class="cli">${items}</div>
      ${note("Placeholders in angle brackets ('<vpc-id>') stand for IDs assigned at apply time: replace them before running a command.")}
    `;
    return {title:cliTitle, count:cmds.length, body: body};
  }},

  {key:"attrs", build: function(r: PlanResource){
    var a = attrRows(r);
    return {title:"Planned attributes", count:a.count, body:a.body};
  }}
];

function note(htmlContent: string | SafeHtml): SafeHtml {
  return html`<div class="cli-note">${htmlContent}</div>`;
}

function copyBlock(label: string, attr: string, inner: string | SafeHtml): SafeHtml {
  return html`
    <div class="cli-item">
      <div class="cli-lbl">
        <span>${label}</span>
        <button class="cli-copy" ${raw(attr)}>copy</button>
      </div>
      ${inner}
    </div>
  `;
}

function addrList(rows: RefRow[]): SafeHtml {
  return html`
    <div class="reflist">
      ${rows.map(function(x: RefRow){
        return x.inPlan
          ? html`<a data-goto="${x.addr}">${x.addr}</a>`
          : html`<span class="ref-missing" title="not in this plan">${x.addr}</span>`;
      })}
    </div>
  `;
}

function attrRows(r: PlanResource): {count: number; body: SafeHtml} {
  var known = Object.keys(r.attrs || {}).filter(function(k: string){
    var v = (r.attrs as any)[k];
    if (v === null || v === undefined || v === "") return false;
    if (Array.isArray(v) && !v.length) return false;
    if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) return false;
    return true;
  }).sort();
  var unknown = Object.keys(r.unknown || {}).filter(function(k: string){
    return (r.unknown as any)[k] === true && known.indexOf(k) < 0;
  }).sort();
  var count = known.length + unknown.length;

  var filterHtml = (count > 10) ? html`
    <div class="attr-search">
      <input type="text" id="attrFilter" placeholder="filter attributes" autocomplete="off">
    </div>
  ` : "";

  var emptyHtml = (!count) ? html`
    <div class="attr">
      <span class="k">\u2014</span>
      <span class="v unknown">no planned values</span>
    </div>
  ` : "";

  var knownHtml = known.map(function(k: string){
    var v = (r.attrs as any)[k];
    var s = (typeof v === "object") ? JSON.stringify(v, null, 2) : String(v);
    var long = s.length > 120;
    if (s.length > 1200) s = s.slice(0, 1200) + "\n\u2026";
    return html`
      <div class="attr" data-k="${k}">
        <span class="k">${k}</span>
        <span class="v${long ? " long" : ""}">${s}</span>
      </div>
    `;
  });

  var unknownHtml = unknown.map(function(k: string){
    return html`
      <div class="attr" data-k="${k}">
        <span class="k">${k}</span>
        <span class="v unknown">known after apply</span>
      </div>
    `;
  });

  var body = html`
    ${filterHtml}
    <div class="attrs" id="attrList">
      ${emptyHtml}
      ${knownHtml}
      ${unknownHtml}
    </div>
  `;

  return {count: count, body: body};
}

/* Sits directly above the sections and right-aligns with their chevrons, so
   it reads as the master switch for the column it lines up with. */
var SEC_MASTER = html`
  <div class="sec-master"><button id="secAll" type="button">
    <span class="lbl"></span>
    <svg class="chev" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button></div>
`;

/* What terraform will do, said as an outcome and marked with the symbol its
   own plan output uses, so it cannot be mistaken for part of the name. */
var ACTION_PHRASE: Record<string, [string, string]> = {
  create:  ["+",   "will be created"],
  update:  ["~",   "will be updated in place"],
  replace: ["-/+", "will be destroyed, then created"],
  "delete":["-",   "will be destroyed"],
  read:    ["<=",  "will be read"],
  "no-op": ["",    "no changes"]
};

function detailHeader(r: PlanResource): SafeHtml {
  var link = consoleLink(r, state.model);
  var consoleName = toolNames(r).console;
  var phrase = ACTION_PHRASE[r.action] || ["", r.action];
  var hasFlags = !r.supported;

  return html`
    <div class="dhd">
      <div class="dhd-top">
        ${icoSvg(r.spec, 34)}
        <div class="dhd-name">
          <span class="type">${r.type}</span>
          <h3>${r.name}</h3>
        </div>
        <span class="act-badge" data-action="${r.action}" title="${phrase[1]}">
          ${r.action}
          ${phrase[0] && html`<i>${phrase[0]}</i>`}
        </span>
      </div>
      ${link && html`<a class="console-link" href="${link}" title="${linkTitle(link, consoleName)}" target="_blank" rel="noopener noreferrer">Open in ${consoleName} \u2197</a>`}
      ${hasFlags && html`
        <div class="badges">
          ${!r.supported && html`<span class="badge badge-warn">not implemented</span>`}
        </div>
      `}
    </div>
  `;
}

function renderDetail(): void {
  if (!detailEl) detailEl = $("detail");
  if (!splitEl) splitEl = $("split");
  var selected = state.selected;
  var model = state.model;
  if (!selected || !model || !model.byAddr[selected]){
    if (splitEl) splitEl.classList.remove("has-detail");
    if (detailEl) detailEl.innerHTML = "";
    return;
  }
  if (splitEl) splitEl.classList.add("has-detail");

  var r = model.byAddr[selected];
  var ctx: any = {};                                  /* builders stash copy targets here */
  var htmlContent = detailHeader(r).toString() + SEC_MASTER.toString();

  DETAIL_SECTIONS.forEach(function(s: DetailSectionDef){
    var built = s.build(r, ctx);
    if (built) htmlContent += sec(s.key, built.title, built.count, built.body);
  });

  if (detailEl) detailEl.innerHTML = htmlContent;
  wireSections();
  wireDetailControls(r, ctx);
}

function wireDetailControls(r: PlanResource, ctx: any): void {
  var filt = $("attrFilter") as HTMLInputElement | null;
  if (filt) filt.addEventListener("input", function(){
    if (!filt || !detailEl) return;
    var q = filt.value.trim().toLowerCase();
    Array.prototype.slice.call(detailEl.querySelectorAll<HTMLElement>("#attrList .attr")).forEach(function(row: HTMLElement){
      row.hidden = !!(q && (row.dataset.k || "").toLowerCase().indexOf(q) < 0);
    });
  });

  if (detailEl) {
    Array.prototype.slice.call(detailEl.querySelectorAll<HTMLElement>(".cli-copy")).forEach(function(b: HTMLElement){
      b.addEventListener("click", function(){
        var text = b.dataset.hcl ? ctx.hcl : (ctx.cmds && b.dataset.cli ? ctx.cmds[parseInt(b.dataset.cli, 10)].cmd : "");
        copyText(text, b);
      });
    });
  }
}

onSelect(renderDetail);

/* Closes whichever view is open in the right pane — a selected resource's
   detail, or the plan-info view from clicking the source name — since both
   just clear the selection and re-render to the same empty state. */
var detailCloseBtn = $("detailClose");
if (detailCloseBtn) detailCloseBtn.addEventListener("click", function(){
  setSelected(null);
  renderDetail();
});

export {
  SEC_DEFAULT, secOpen, isOpen, CHEV, sec,
  detailSections, wireSections, SECTION_USE, sectionRows,
  driftRows, checkRows, renderPlanInfo, DETAIL_SECTIONS,
  note, copyBlock, addrList, attrRows, SEC_MASTER, ACTION_PHRASE,
  detailHeader, renderDetail, wireDetailControls, copyText
};
