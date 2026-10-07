import { $, html, type SafeHtml } from "../core/util.js";
import { categoryColor, blockHeight, typeWithoutPrefix, tileSubtitleFor, getProviderForResource } from "../core/registry.js";
import { TW, TH, tileHeight, setTileHeight, buildTree } from "../core/layout.js";
import { fitCanvas, applyTransform } from "./iso.js";
import { sameVal, changedKeys } from "../core/diff.js";
import { state, setSelected, notifySelect, notifyRender } from "../core/state.js";
import { buildTileLlmChipHtml } from "./llm-review.js";
import type { PlanModel, PlanResource, CatalogEntry, LayoutGroup } from "../types/index.js";

var canvas = $("canvas"), edgesSvg = $("edges"), detailEl = $("detail"), splitEl = $("split");

var ACTION_COLOR = {
  create:"var(--create)", update:"var(--update)", replace:"var(--replace)",
  delete:"var(--destroy)", "no-op":"var(--noop)", read:"var(--update)"
};

function icoSvg(spec: CatalogEntry | null | undefined, size: number): SafeHtml {
  var color = (spec && categoryColor(spec.cat)) || "var(--warn)";
  var id = spec ? spec.icon : "i-unknown";
  return html`<svg class="ico" style="color:${color}" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><use href="#${id}"/></svg>`;
}

function titleFor(r: PlanResource): string {
  if (r.spec) return r.spec.label;
  return typeWithoutPrefix(r.type, getProviderForResource(r)).replace(/_/g, " ").replace(/\b\w/g, function(c: string){ return c.toUpperCase(); });
}

function subFor(r: PlanResource): string {
  if (r.spec && r.spec.sub && (r.attrs as any)[r.spec.sub]){
    return tileSubtitleFor(r, String((r.attrs as any)[r.spec.sub]));
  }
  if ((r.attrs as any).cidr_block) return String((r.attrs as any).cidr_block);
  return "";
}

function setEmpty(on: boolean): void {
  var es = $("emptyState");
  if (es) es.hidden = !on;
  var c = $("canvas");
  if (c) c.style.display = on ? "none" : "";
}

function syncFilterBanner(): void {
  var b = $("filterBanner");
  if (!b) return;
  if (!state.model || !state.opts.action){
    b.hidden = true;
    var pane = $("canvasPane");
    if (pane) pane.classList.remove("filtered");
    return;
  }
  var c = (ACTION_COLOR as any)[state.opts.action];
  b.hidden = false;
  b.innerHTML = html`showing only <b style="color:${c}">${state.opts.action}</b><span class="x">\u00d7</span>`.toString();
  b.title = "Click to show everything again";
  b.onclick = function(){ state.opts.action = null; render(); };
  var p = $("canvasPane");
  if (p) p.classList.add("filtered");
}

function render(): void {
  syncFilterBanner();
  if (!state.model){ setEmpty(true); return; }
  if (state.opts.render === "text"){ notifyRender(); return; }
  setEmpty(!state.model.resources.length);
  // recompute enabledType flags
  state.model.resources.forEach(function(r: PlanResource){
    if (r.enabledType === undefined) r.enabledType = true;
  });

  var S: any = state.model.summary || {};
  var hasEdits = (S.update || 0) + (S.replace || 0) + (S["delete"] || 0) > 0;
  state.model.hasEdits = hasEdits;
  /* creates count here too: dim what the plan leaves alone even when it only adds things */
  var hasChanges = hasEdits || (S.create || 0) > 0;

  setTileHeight(tileHeight(state.opts.mode, hasEdits));
  if (!canvas) canvas = $("canvas");
  if (canvas) {
    canvas.classList.toggle("mode-changes", state.opts.mode === "changes");
    canvas.classList.toggle("emphasise", state.opts.mode === "changes" && hasChanges);
    canvas.classList.toggle("pulse", !!state.opts.pulse && state.opts.mode === "changes" && hasEdits);
    canvas.classList.toggle("hide-llm", !state.opts.showLlm);
  }

  var tree = buildTree(state.model, state.opts);

  // clear
  if (canvas) {
    Array.prototype.slice.call(canvas.querySelectorAll(".grp,.node")).forEach(function(n: HTMLElement){ n.remove(); });
  }
  state.nodeEls = {};

  if (canvas) {
    canvas.style.width = tree.w + "px";
    canvas.style.height = tree.h + "px";
  }
  fitCanvas(tree.w, tree.h);
  applyTransform();

  if (!edgesSvg) edgesSvg = $("edges");
  if (edgesSvg) {
    edgesSvg.setAttribute("width", String(tree.w));
    edgesSvg.setAttribute("height", String(tree.h));
    edgesSvg.setAttribute("viewBox", "0 0 " + tree.w + " " + tree.h);
  }

  (function walk(g: LayoutGroup, depth: number){
    depth = depth || 0;
    if (g.box){
      var d = document.createElement("div");
      var gChanged = g.res && g.res.action !== "no-op" && g.res.action !== "read";
      d.className = "grp " + g.cls + (g.res ? " act-" + g.res.action : "") +
                    (gChanged ? " is-changed" : "");
      if (gChanged && g.res) d.style.setProperty("--pulse", (ACTION_COLOR as any)[g.res.action]);
      d.style.setProperty("--z", String(depth * 3));
      d.style.left = g.x + "px"; d.style.top = g.y + "px";
      d.style.width = g.w + "px"; d.style.height = g.h + "px";
      /* Cloud, Region and AZ are drawn as outlines in the group's own colour;
         a container backed by a resource takes that resource's service tile. */
      var ic: SafeHtml | null = null;
      if (g.cls === "cloud"){
        ic = html`<svg viewBox="0 0 48 48" aria-hidden="true"><use href="#i-cloud"/></svg>`;
      } else if (g.cls === "region" || g.cls === "az"){
        ic = html`<svg viewBox="0 0 48 48" aria-hidden="true"><use href="#i-region"/></svg>`;
      } else if (g.res && g.res.spec){
        var catCol = categoryColor(g.res.spec.cat) || "var(--warn)";
        ic = html`<svg class="tile" viewBox="0 0 48 48" aria-hidden="true" style="color:${catCol}"><use href="#${g.res.spec.icon}"/></svg>`;
      }
      var gAct: SafeHtml | null = null;
      if (g.res && state.opts.mode === "changes" &&
          g.res.action !== "no-op" && g.res.action !== "read"){
        var gk = changedKeys(g.res);
        var title = g.res.addr + (gk.length ? " \u2014 " + gk.join(", ") : "");
        gAct = html`
          <span class="grp-act" data-action="${g.res.action}" title="${title}">
            ${g.res.action}
          </span>
        `;
      }
      var gLlm = (g.res && g.res.llmInsight) ? buildTileLlmChipHtml(g.res.llmInsight) : null;
      d.innerHTML = html`
        <div class="grp-hd">
          ${ic}
          <span class="grp-lbl" title="${g.label}">${g.label}</span>
          ${g.meta && html`<em>${g.meta}</em>`}
          ${gLlm}
          ${gAct}
        </div>
        <i class="fc n"></i><i class="fc w"></i>
      `.toString();
      if (g.res){
        const res = g.res;
        d.dataset.addr = res.addr;
        d.style.cursor = "pointer";
        d.addEventListener("click", function(e: MouseEvent){ if (state.suppressClick) return; e.stopPropagation(); select(res.addr); });
        state.nodeEls[res.addr] = d;
      }
      if (canvas) canvas.appendChild(d);
      g.children.forEach(function(k: any){ walk(k, depth + 1); });
    } else {
      var r = g.res;
      if (!r) return;
      var n = document.createElement("div");
      var isChanged = r.action !== "no-op" && r.action !== "read";
      n.className = "node act-" + r.action + (isChanged ? " is-changed" : "") +
                    (r.supported ? "" : " unsup");
      if (isChanged) n.style.setProperty("--pulse", (ACTION_COLOR as any)[r.action]);
      n.style.left = g.x + "px"; n.style.top = g.y + "px";
      n.style.width = TW + "px"; n.style.height = TH + "px";
      n.style.setProperty("--h", blockHeight(r) + "px");
      n.dataset.addr = r.addr;
      var sub = subFor(r);
      if (sub && sub.toLowerCase() === String(r.name).toLowerCase()) sub = "";
      var line2 = html`${r.name}${sub && html` <i>· ${sub}</i>`}`;
      /* Topology is structure: every tile is drawn the same way, with the
         action carried only by the optional dot. Changes names the action
         on every tile, because that is what the mode is for. */
      var plain = (state.opts.mode !== "changes") || (r.action === "no-op");
      if (!plain) n.className += " has-chip";

      var llmChip = r.llmInsight ? buildTileLlmChipHtml(r.llmInsight) : null;

      n.innerHTML = html`
        ${llmChip}
        ${plain
          ? html`<span class="act" data-action="${r.action}" title="${r.action}"></span>`
          : html`<span class="actw" data-action="${r.action}">${r.action}</span>`}
        ${icoSvg(r.spec, 24)}
        <div class="ttl">${titleFor(r)}</div>
        <div class="nm" title="${r.name + (sub ? "  ·  " + sub : "")}">${line2}</div>
        <i class="fc n"></i><i class="fc w"></i>
      `.toString();

      if (state.opts.mode === "changes" && state.model && state.model.hasEdits && r.action !== "no-op" && r.action !== "read"){
        var ck = changedKeys(r);
        var forced = (r.replacePaths || []).map(function(pp: any){ return Array.isArray(pp) ? pp[0] : pp; });
        var bodyHtml: SafeHtml;
        if (!ck.length){
          bodyHtml = html`<span class="q">${r.action === "create" ? "new resource" : "no attribute changes"}</span>`;
        } else {
          var rendered = ck.slice(0, 3).map(function(k: string, i: number){
            var isForced = forced.indexOf(k) >= 0;
            return html`${i > 0 ? ", " : ""}${isForced ? html`<b title="forces replacement">${k}</b>` : k}`;
          });
          var extra = ck.length > 3 ? html` <span class="q">+${ck.length - 3}</span>` : "";
          bodyHtml = html`${rendered}${extra}`;
        }
        var cd = document.createElement("div");
        cd.className = "chgline";
        cd.innerHTML = bodyHtml.toString();
        n.appendChild(cd);
      }
      const res = r;
      n.addEventListener("click", function(e: MouseEvent){ if (state.suppressClick) return; e.stopPropagation(); select(res.addr); });
      if (canvas) canvas.appendChild(n);
      state.nodeEls[r.addr] = n;
    }
  })(tree, 0);

  drawEdges();
  applySelection();
  notifyRender();
}

interface BoxInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  grp: boolean;
}

/* --- edges --- */
function boxOf(addr: string): BoxInfo | null {
  var el = state.nodeEls[addr];
  if (!el) return null;
  var x = parseFloat(el.style.left), y = parseFloat(el.style.top);
  var w = parseFloat(el.style.width), h = parseFloat(el.style.height);
  return {x:x, y:y, w:w, h:h, cx:x + w/2, cy:y + h/2, grp:el.classList.contains("grp")};
}

/* a tile connects at its centre; a container connects where the line meets
   its edge, so the arrow does not stop in the middle of its contents */
function anchor(b: BoxInfo, toward: {x: number; y: number}): {x: number; y: number} {
  if (!b.grp) return {x:b.cx, y:b.cy};
  var dx = toward.x - b.cx, dy = toward.y - b.cy;
  if (!dx && !dy) return {x:b.cx, y:b.cy};
  var s = Math.min(dx ? (b.w/2)/Math.abs(dx) : Infinity,
                   dy ? (b.h/2)/Math.abs(dy) : Infinity);
  return {x:b.cx + dx*s, y:b.cy + dy*s};
}

/* A splat reference (aws_subnet.public[*].id) is recorded as the bare base
   address ("aws_subnet.public") with no [N] — but nothing is ever rendered
   under that address, only real instances ("aws_subnet.public[0]", "[1]").
   Resolve it to every instance actually sharing that base address, so an
   edge still gets drawn to each of them instead of silently to none.

   Takes the resource's whole refs list, not one address at a time: Terraform
   also lists an ordinary single reference's base form ("aws_subnet.public")
   right alongside its specific one ("aws_subnet.public[0]") in the same
   array — not a real splat, just a coarser mention of the same target (see
   resolveMatches in providers/aws/placement.ts, which guards against the
   identical shape). Resolving one address at a time can't see that the
   specific form is already present, so it would draw a spurious extra edge
   to every OTHER instance sharing that base address. */
function resolveEdgeTargets(refs: string[]): string[] {
  var out: string[] = [];
  function add(a: string){ if (out.indexOf(a) < 0) out.push(a); }
  var specificBases: Record<string, boolean> = {};
  refs.forEach(function(ref: string){
    if (state.nodeEls[ref] && /\[[^\]]*\]$/.test(ref)) specificBases[ref.replace(/\[[^\]]*\]$/, "")] = true;
  });
  refs.forEach(function(ref: string){
    if (state.nodeEls[ref]){ add(ref); return; }
    if (specificBases[ref]) return;
    var prefix = ref + "[";
    for (var k in state.nodeEls){ if (k.indexOf(prefix) === 0) add(k); }
  });
  return out;
}

function encloses(a: string, b: string): boolean {
  if (!state.model) return false;
  var ka = state.model.anc && state.model.anc[a], kb = state.model.anc && state.model.anc[b];
  return !!((ka && ka.indexOf(b) >= 0) || (kb && kb.indexOf(a) >= 0));
}

function drawEdges(): void {
  if (!edgesSvg) edgesSvg = $("edges");
  if (!edgesSvg) return;
  edgesSvg.innerHTML = "";
  if (!state.model || state.opts.edges === "none") return;
  var show: [string, string][] = [];
  var seen: Record<string, boolean> = {};
  var selected = state.selected;
  state.model.resources.forEach(function(r: PlanResource){
    if (!state.nodeEls[r.addr]) return;
    resolveEdgeTargets(r.refs).forEach(function(a: string){
      if (encloses(r.addr, a)) return;                       /* nesting shows it */
      if (state.nodeEls[r.addr].classList.contains("grp")) return; /* containers are */
      if (state.nodeEls[a].classList.contains("grp")) return;      /* highlighted instead */
      if (state.opts.edges === "select"){
        if (!selected) return;
        if (r.addr !== selected && a !== selected) return;
      }
      var key = r.addr + "|" + a;
      if (seen[key]) return;
      seen[key] = true;
      show.push([r.addr, a]);
    });
  });
  show.forEach(function(pair: [string, string]){
    var ba = boxOf(pair[0]), bb = boxOf(pair[1]);
    if (!ba || !bb) return;
    var a = anchor(ba, {x:bb.cx, y:bb.cy});
    var b = anchor(bb, {x:ba.cx, y:ba.cy});
    var mx = (a.x + b.x)/2;
    var p = document.createElementNS("http://www.w3.org/2000/svg","path");
    p.setAttribute("d", "M" + a.x + "," + a.y + " C" + mx + "," + a.y + " " + mx + "," + b.y + " " + b.x + "," + b.y);
    p.setAttribute("fill","none");
    p.setAttribute("stroke", (selected && (pair[0]===selected||pair[1]===selected)) ? "var(--accent)" : "var(--line)");
    p.setAttribute("stroke-width", (selected && (pair[0]===selected||pair[1]===selected)) ? "2" : "1.2");
    p.setAttribute("stroke-dasharray", "5 4");
    p.setAttribute("opacity", state.opts.edges === "all" && !selected ? ".55" : "1");
    if (edgesSvg) edgesSvg.appendChild(p);
  });
}

/* --- selection --- */
function select(addr: string | null): void {
  setSelected(state.selected === addr ? null : addr);
  applySelection();
  drawEdges();
  notifySelect(state.selected);
}

function applySelection(): void {
  var selected = state.selected;
  var related: Record<string, boolean> = {};
  if (selected && state.model){
    related[selected] = true;
    var r = state.model.byAddr[selected];
    if (r){
      r.refs.forEach(function(a: string){ related[a] = true; });
      (r.dependents||[]).forEach(function(a: string){ related[a] = true; });
    }
  }
  Object.keys(state.nodeEls).forEach(function(addr: string){
    var el = state.nodeEls[addr];
    el.classList.toggle("sel", addr === selected);
    el.classList.toggle("rel", !!selected && related[addr] && addr !== selected);
    el.classList.toggle("dim", !!selected && !related[addr]);
  });

  if (selected && state.nodeEls[selected]) {
    var selEl = state.nodeEls[selected];
    if (typeof selEl.scrollIntoView === "function") {
      try {
        selEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      } catch (e) {
        selEl.scrollIntoView();
      }
    }
  }
}

export {
  canvas, edgesSvg, detailEl, splitEl,
  ACTION_COLOR, icoSvg, changedKeys, titleFor, subFor, setEmpty, syncFilterBanner,
  render, boxOf, anchor, encloses, drawEdges, select, applySelection
};
