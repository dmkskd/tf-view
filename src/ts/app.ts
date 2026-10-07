// app.js — Main application lifecycle, state & event orchestration
import { $, html } from "./core/util.js";
import { parsePlan } from "./core/parser.js";
import { addProviderIconSymbols } from "./core/icons.js";
import { isSchemaFile, pruneSchema, storeSchema, restoreSchema } from "./core/schema.js";
import { state, setModel, setSelected, onMode } from "./core/state.js";
import {
  canvas, edgesSvg, render, select, setEmpty, applySelection,
  drawEdges, ACTION_COLOR
} from "./ui/diagram.js";
import { renderText, planText } from "./ui/textview.js";
import { renderSidebar, setTypes } from "./ui/sidebar.js";
import { renderDetail, renderPlanInfo, copyText } from "./ui/detail.js";
import { linksEnabled, setLinksEnabled, restoreLinksEnabled } from "./core/links.js";
import { closeCtx } from "./ui/contextmenu.js";
import { fitView, setIso, ISO } from "./ui/iso.js";
import "./ui/rule-popover.js";
import type { PlanModel, PlanResource } from "./types/index.js";

function load(plan: any, name: string, rawText?: string): void {
  var model = parsePlan(plan, name);
  model.raw = plan;
  model.rawText = rawText || JSON.stringify(plan, null, 2);
  model.rawBytes = (rawText || model.rawText).length;
  model.timestamp = plan.timestamp || null;
  setModel(model);
  setSelected(null);
  var srcName = $("srcName");
  if (srcName) {
    srcName.innerHTML = html`
      <svg class="src-tf" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><use href="#i-terraform"/></svg>
      <span class="src-pfx">plan</span>
      <b class="src-file">${name}</b>
      <span class="src-arr">\u203a</span>
    `.toString();
    srcName.title = "Active plan: " + name + " (" + model.resources.length + " resources) \u2014 Click to inspect details & JSON";
  }
  model.resources.forEach(function(r: PlanResource){ r.enabledType = true; });
  var hasLlm = !!(model && model.llmReview);
  var toggleLlm = $("toggleLlm");
  if (toggleLlm) {
    toggleLlm.hidden = !hasLlm;
    toggleLlm.classList.toggle("on", state.opts.showLlm);
    toggleLlm.setAttribute("aria-pressed", state.opts.showLlm ? "true" : "false");
    var modelName = (hasLlm && model.llmReview && model.llmReview.model) || "";
    var providerName = (hasLlm && model.llmReview && model.llmReview.provider) || "";
    var fullModel = providerName ? (providerName + " / " + modelName) : modelName;
    toggleLlm.innerHTML = '<span class="sw"></span>LLM Review';
    toggleLlm.title = "Toggle LLM risk badges" + (fullModel ? " \u00b7 Reviewed with " + fullModel : "");
  }
  var optLlmWrap = $("optLlmWrap");
  if (optLlmWrap) optLlmWrap.hidden = !hasLlm;
  var optLlm = $("optLlm") as HTMLInputElement | null;
  if (optLlm) optLlm.checked = state.opts.showLlm;
  render();
  requestAnimationFrame(fitView);      /* after the pane has its real size */
  renderDetail();
}

function loadText(text: string, name: string): void {
  var plan: any;
  try { plan = JSON.parse(text); }
  catch (e: any){
    var errModel: any = {resources:[], byAddr:{}, typeCounts:{}, diagnostics:[
      {level:"err", code:"parse", msg:"Could not parse this file as JSON \u2014 **" + String(e && e.message || e).replace(/\*/g, "") + "**"}
    ]};
    setModel(errModel);
    var srcName = $("srcName");
    if (srcName) {
      srcName.innerHTML = html`
        <svg class="src-tf" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><use href="#i-terraform"/></svg>
        <span class="src-pfx">plan</span>
        <b class="src-file">${name}</b>
      `.toString();
    }
    if (canvas) Array.prototype.slice.call(canvas.querySelectorAll(".grp,.node")).forEach(function(n: HTMLElement){ n.remove(); });
    if (edgesSvg) edgesSvg.innerHTML = "";
    renderSidebar();
    return;
  }
  if (isSchemaFile(plan)){
    var model = state.model;
    if (!model){
      var diagEl = $("diag");
      if (diagEl) {
        diagEl.innerHTML = html`<div class="dg warn"><span class="ic">!</span><span>That is a provider
          schema. Load a plan first, then drop it again so it can be pruned to
          the types the plan uses.</span></div>`.toString();
      }
      return;
    }
    var pr = pruneSchema(plan, Object.keys(model.typeCounts));
    if (!pr.meta.types){
      if (model.diag) {
        model.diag("warn", "schema-empty",
          "That schema covers no type in this plan. Diffs stay inferred.");
      }
    } else {
      storeSchema(pr.schema, pr.meta);
      if (model.diag) {
        model.diag("ok", "schema",
          "Provider schema loaded for **" + pr.meta.types + "** of this plan\u2019s types. " +
          "Collection diffs are now schema-verified.");
      }
    }
    render();
    if (state.selected) renderDetail();
    return;
  }
  load(plan, name, text);
}

var srcName = $("srcName");
if (srcName) srcName.addEventListener("click", function(){ if (state.model) renderPlanInfo(); });
var loadBtn = $("loadBtn");
if (loadBtn) loadBtn.addEventListener("click", function(){
  var fi = $("fileInput");
  if (fi) fi.click();
});
var fileInput = $("fileInput");
if (fileInput) fileInput.addEventListener("change", function(e: Event){
  var target = e.target as HTMLInputElement;
  var file = target.files && target.files[0];
  if (!file) return;
  var fr = new FileReader();
  fr.onload = function(){ loadText(String(fr.result), file ? file.name : ""); };
  fr.readAsText(file);
});

/* dragenter/dragleave fire on every nested element a drag crosses, not just
   the document root, so a plain enter/leave toggle gets stuck "on" whenever
   the drag exits over a child element instead of exactly at <html>. Track
   nesting depth instead, and reset on drop/dragend as a fail-safe. */
var dragDepth = 0;
/* Settings that a report generator (the tfview CLI,
   demo/atlantis/shared/inject.js) writes into the tfview-config JSON data
   block. A data block, unlike an inline script, does not need its own hash
   in the Content-Security-Policy. Only the fields below are read, and each
   is type-checked. */
interface BootConfig { autoload: boolean; viewerOnly: boolean; showChanges: boolean; label: string; }
var bootConfigCache: BootConfig | null = null;
function bootConfig(): BootConfig {
  if (bootConfigCache) return bootConfigCache;
  var c: any = {};
  try { c = JSON.parse(sampleText("tfview-config") || "{}") || {}; } catch (e) { c = {}; }
  bootConfigCache = {
    autoload: c.autoload === true,
    viewerOnly: c.viewerOnly === true,
    showChanges: c.showChanges === true,
    label: typeof c.label === "string" && c.label ? c.label.slice(0, 200) : "terraform plan"
  };
  return bootConfigCache;
}
/* A report injected with its plan (viewerOnly) only shows that plan: no loading, no samples. */
function viewerOnly(): boolean { return bootConfig().viewerOnly; }
document.addEventListener("dragenter", function(e: Event){
  e.preventDefault(); if (viewerOnly()) return;
  dragDepth++; document.body.classList.add("dragging");
});
document.addEventListener("dragover", function(e: Event){ e.preventDefault(); });
document.addEventListener("dragleave", function(e: Event){
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove("dragging");
});
["drop","dragend"].forEach(function(ev: string){
  document.addEventListener(ev, function(e: Event){ e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging"); });
});
document.addEventListener("drop", function(e: DragEvent){
  if (viewerOnly()) return;
  var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  var fr = new FileReader();
  fr.onload = function(){ loadText(String(fr.result), file ? file.name : ""); };
  fr.readAsText(file);
});

var canvasWrap = $("canvasWrap");
if (canvasWrap) canvasWrap.addEventListener("click", function(){
  if (state.suppressClick) return;
  if (state.selected){ setSelected(null); applySelection(); drawEdges(); renderDetail(); }
});

var actLegend = $("actLegend");
if (actLegend) {
  actLegend.innerHTML = ["create","update","replace","delete"].map(function(a: string){
    return '<span><i class="sw" style="border-radius:50%;background:' + (ACTION_COLOR as any)[a] + '"></i>' + a + '</span>';
  }).join("");
}

var optActions = $("optActions");
if (optActions) optActions.addEventListener("change", function(e: Event){
  if (canvas) canvas.classList.toggle("no-actions", !(e.target as HTMLInputElement).checked);
});

var isoFit = $("isoFit");
if (isoFit) isoFit.addEventListener("click", function(e: MouseEvent){ e.stopPropagation(); fitView(); });

function applyView(): void {
  var opts = state.opts;
  var modeChg = $("modeChg");
  if (modeChg) modeChg.setAttribute("aria-pressed", opts.mode === "changes" ? "true" : "false");
  var renderFlat = $("renderFlat");
  if (renderFlat) renderFlat.classList.toggle("on", opts.render === "diagram" && !ISO.on);
  var renderIso = $("renderIso");
  if (renderIso) renderIso.classList.toggle("on", opts.render === "diagram" && ISO.on);
  var renderTextBtn = $("renderText");
  if (renderTextBtn) renderTextBtn.classList.toggle("on", opts.render === "text");

  var isText = opts.render === "text";
  var textView = $("textView");
  if (textView) textView.hidden = !isText;
  var canvasPane = $("canvasPane");
  if (canvasPane) canvasPane.hidden = isText;

  var toggleLlm = $("toggleLlm");
  if (toggleLlm) {
    toggleLlm.classList.toggle("on", opts.showLlm);
    toggleLlm.setAttribute("aria-pressed", opts.showLlm ? "true" : "false");
  }
  var optLlm = $("optLlm") as HTMLInputElement | null;
  if (optLlm) optLlm.checked = opts.showLlm;
  if (canvas) canvas.classList.toggle("hide-llm", !opts.showLlm);

  if (isText) {
    renderText();
    renderSidebar();
  } else {
    render();
    fitView();
  }
}
function applyMode(m: "all" | "changes"): void { state.opts.mode = m; applyView(); }
function setRender(r: "diagram" | "text"): void { state.opts.render = r; applyView(); }
function setLlm(show: boolean): void {
  state.opts.showLlm = show;
  if (canvas) canvas.classList.toggle("hide-llm", !show);
  var toggleLlm = $("toggleLlm");
  if (toggleLlm) {
    toggleLlm.classList.toggle("on", show);
    toggleLlm.setAttribute("aria-pressed", show ? "true" : "false");
  }
  var optLlm = $("optLlm") as HTMLInputElement | null;
  if (optLlm) optLlm.checked = show;
  if (state.opts.render === "text") renderText();
}
onMode(function(){ applyView(); });

var modeChg = $("modeChg");
if (modeChg) modeChg.addEventListener("click", function(){
  applyMode(state.opts.mode === "changes" ? "all" : "changes");
});
var toggleLlm = $("toggleLlm");
if (toggleLlm) toggleLlm.addEventListener("click", function(){
  setLlm(!state.opts.showLlm);
});
/* ---------- settings (gear popover) ---------- */
(function(){
  var btn = $("settingsBtn"), menu = $("settingsMenu");
  var optLinks = $("optLinks") as HTMLInputElement | null;
  if (!btn || !menu || !optLinks) return;
  var pop = menu, gear = btn;
  function close(): void {
    pop.hidden = true;
    gear.setAttribute("aria-expanded", "false");
  }
  optLinks.checked = restoreLinksEnabled();
  optLinks.addEventListener("change", function(){
    setLinksEnabled(optLinks!.checked);
    if (state.selected) renderDetail();
  });
  pop.addEventListener("click", function(e: MouseEvent){ e.stopPropagation(); });
  gear.addEventListener("click", function(e: MouseEvent){
    e.stopPropagation();
    if (!pop.hidden){ close(); return; }
    var r = gear.getBoundingClientRect();
    pop.hidden = false;
    gear.setAttribute("aria-expanded", "true");
    var w = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
    pop.style.top = (r.bottom + 6) + "px";
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", function(e: KeyboardEvent){ if (e.key === "Escape") close(); });
})();

var renderTextBtn = $("renderText");
if (renderTextBtn) renderTextBtn.addEventListener("click", function(){ setRender("text"); });

var tvCopy = $("tvCopy");
if (tvCopy) tvCopy.addEventListener("click", function(){
  var el = document.createElement("div");
  el.innerHTML = planText();
  if (tvCopy) copyText(el.textContent || "", tvCopy);
});

var typesAll = $("typesAll");
if (typesAll) typesAll.addEventListener("click", function(){
  if (state.model) setTypes(Object.keys(state.model.typeCounts), true);
});
var typesNone = $("typesNone");
if (typesNone) typesNone.addEventListener("click", function(){
  if (state.model) setTypes(Object.keys(state.model.typeCounts), false);
});

var optPulse = $("optPulse");
if (optPulse) optPulse.addEventListener("change", function(e: Event){
  state.opts.pulse = (e.target as HTMLInputElement).checked;
  var model = state.model;
  if (canvas) canvas.classList.toggle("pulse", !!(state.opts.pulse && state.opts.mode === "changes" && model && model.hasEdits));
});
var optLlm = $("optLlm");
if (optLlm) optLlm.addEventListener("change", function(e: Event){
  setLlm((e.target as HTMLInputElement).checked);
});
var optAssoc = $("optAssoc");
if (optAssoc) optAssoc.addEventListener("change", function(e: Event){ state.opts.showAssoc = (e.target as HTMLInputElement).checked; render(); });
var optUnsup = $("optUnsup");
if (optUnsup) optUnsup.addEventListener("change", function(e: Event){ state.opts.showUnsup = (e.target as HTMLInputElement).checked; render(); });
var optEdges = $("optEdges");
if (optEdges) optEdges.addEventListener("change", function(e: Event){ state.opts.edges = (e.target as HTMLSelectElement).value as any; drawEdges(); });


/* ---------- theme (standalone only; the page is themed by tokens) ---------- */
(function(){
  var btn = $("themeBtn");
  if (!btn) return;
  var modes = ["auto","light","dark"], cur = "auto";
  try { cur = localStorage.getItem("tfplanview-theme") || "auto"; } catch(e){}
  var ICONS: Record<string, string> = {
    auto:  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" ' +
           'fill="none" stroke="currentColor" stroke-width="1.6"/>' +
           '<path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" ' +
           'fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" ' +
           'stroke-linecap="round"><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15' +
           'M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1"/></g></svg>',
    dark:  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" ' +
           'd="M13.3 9.8A5.8 5.8 0 0 1 6.2 2.7a5.8 5.8 0 1 0 7.1 7.1z"/></svg>'
  };

  function apply(): void {
    if (!btn) return;
    if (cur === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", cur);
    btn.innerHTML = ICONS[cur] || ICONS.auto;
    btn.title = "Theme: " + cur;
    try { localStorage.setItem("tfplanview-theme", cur); } catch(e){}
  }
  btn.addEventListener("click", function(){
    cur = modes[(modes.indexOf(cur) + 1) % modes.length];
    apply();
  });
  apply();
})();

var renderFlatBtn = $("renderFlat");
if (renderFlatBtn) renderFlatBtn.addEventListener("click", function(){ setRender("diagram"); setIso(false); });
var renderIsoBtn = $("renderIso");
if (renderIsoBtn) renderIsoBtn.addEventListener("click", function(){ setRender("diagram"); setIso(true); });
(function(){
  var want = "0";
  try { want = localStorage.getItem("tfplanview-iso") || "0"; } catch(e){}
  setIso(want === "1");
})();

/* Sample plans are large JSON blobs parked at the end of the file, so they
   do not sit in the middle of the source. That puts them after this script,
   so each is read on demand and the boot waits for the document to finish
   parsing. */
var SAMPLE_LABELS: Record<string, string> = {
  "embedded-plan": "bundled sample",
  "embedded-plan-fullstack": "aws full-stack sample",
  "embedded-plan-eks": "eks (llm review) sample"
};
var DEFAULT_SAMPLE_ID = "embedded-plan";
/* Display text for the dropdown menu — separate from SAMPLE_LABELS, which
   is the "source" name shown elsewhere once a sample is actually loaded. */
var SAMPLE_MENU_ITEMS: [string, string][] = [
  ["embedded-plan", "Single EC2"],
  ["embedded-plan-fullstack", "Web app (ALB+RDS)"],
  ["embedded-plan-eks", "EKS Cluster (LLM)"]
];

function sampleText(id: string): string {
  var el = document.getElementById(id);
  var t = el ? (el.textContent || "").trim() : "";
  return t.length > 2 ? t : "";
}

function loadSample(id: string): void {
  var t = sampleText(id);
  if (!t) return;
  var label = SAMPLE_LABELS[id] || "bundled sample";
  try { load(JSON.parse(t), label, t); }
  catch(e){ loadText(t, label); }
}

/* Sample picker: a button (its label always just reads "Sample", it is not
   a status indicator) that opens a small menu of the bundled plans, reusing
   the same floating-menu look as the canvas context menu. */
var sampleBtn = $("sampleBtn") as HTMLButtonElement | null;
var sampleMenu = $("sampleMenu");
var emptySampleBtn = $("emptySampleBtn");

function closeSampleMenu(): void {
  if (sampleMenu) sampleMenu.hidden = true;
  if (sampleBtn) sampleBtn.setAttribute("aria-expanded", "false");
}

function openSampleMenu(): void {
  if (!sampleBtn || !sampleMenu) return;
  sampleMenu.innerHTML = "";
  SAMPLE_MENU_ITEMS.forEach(function(item){
    var id = item[0], label = item[1];
    var b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", function(e: MouseEvent){
      e.stopPropagation();
      closeSampleMenu();
      loadSample(id);
    });
    sampleMenu!.appendChild(b);
  });
  var r = sampleBtn.getBoundingClientRect();
  sampleMenu.hidden = false;
  sampleBtn.setAttribute("aria-expanded", "true");
  var w = sampleMenu.offsetWidth;
  sampleMenu.style.left = Math.min(r.left, window.innerWidth - w - 8) + "px";
  sampleMenu.style.top = (r.bottom + 6) + "px";
}

if (sampleBtn) sampleBtn.addEventListener("click", function(e: MouseEvent){
  e.stopPropagation();
  if (sampleMenu && !sampleMenu.hidden) closeSampleMenu();
  else openSampleMenu();
});
document.addEventListener("click", function(){ if (sampleMenu && !sampleMenu.hidden) closeSampleMenu(); });
document.addEventListener("keydown", function(e: KeyboardEvent){ if (e.key === "Escape") closeSampleMenu(); });

if (emptySampleBtn) emptySampleBtn.addEventListener("click", function(){ loadSample(DEFAULT_SAMPLE_ID); });

function boot(): void {
  if (viewerOnly()) document.body.classList.add("viewer-only");
  addProviderIconSymbols(document);
  restoreSchema();
  var has = !!sampleText(DEFAULT_SAMPLE_ID);
  if (sampleBtn) sampleBtn.disabled = !has;
  var emptySBtn = $("emptySampleBtn") as HTMLButtonElement | null;
  if (emptySBtn) emptySBtn.disabled = !has;

  var cfg = bootConfig();
  var injected = sampleText("injected-plan");
  var text = injected || (has ? sampleText(DEFAULT_SAMPLE_ID) : "");
  if (cfg.autoload && text) {
    try { load(JSON.parse(text), cfg.label, text); }
    catch(e){ loadText(text, cfg.label); }
    /* switch to Changes mode, unless the plan changes nothing (the Changes
       button is then disabled) */
    var chg = $("modeChg") as HTMLButtonElement | null;
    if (cfg.showChanges && chg && !chg.disabled) applyMode("changes");
    return;
  }
  setEmpty(true);
  var diagEl = $("diag");
  if (diagEl) {
    diagEl.innerHTML = has
      ? '<div class="dg info"><span class="ic">i</span><span>No plan loaded. Drop a <b>terraform show -json</b> file anywhere on this page, or pick a <b>Sample plan</b>.</span></div>'
      : '<div class="dg info"><span class="ic">i</span><span>No plan loaded and no sample bundled. Drop a <b>terraform show -json</b> file anywhere on this page.</span></div>';
  }
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

export { load, loadText, boot, applyView, applyMode, setRender };
