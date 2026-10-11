// ui/svgdetails.ts — a section per change, for a pull request comment
//
// For the most important changes (ACTION_RANK, then plan order): a still SVG
// cropped around the resource, with a ring on it, and a Markdown <details>
// block with the crop, the reason Terraform gives and the attribute
// changes. Each crop's address is left as @@IMG<n>@@ in the Markdown: the
// caller uploads files[n] and puts its URL there (demo/atlantis/shared/lib.sh).
// Values come from the model, already redacted ("(sensitive value)").
import { buildSvg, round, ACTION_RANK, PAD, HEAD, type Stop, type Pt } from "./svgexport.js";
import { changedKeys, valText, reasonText } from "../core/diff.js";
import { state } from "../core/state.js";

const CROP_W = 720, CROP_H = 280;
const MAX_LINES = 12, MAX_VALUE = 120;

export interface DetailsItem {
  action: string; addr: string; title: string;
  reasonHtml: string | null;   /* reasonText: escaped HTML */
  lines: string[];             /* the diff block */
  file: number;                /* its crop, in files */
}

export interface DetailsExport {
  markdown: string;
  files: { name: string; svg: string }[];
  items: DetailsItem[];        /* the same sections, for the in-page preview */
  total: number;               /* changes drawn on the canvas */
}

function oneLine(v: any): string {
  var s = typeof v === "string" ? v : (v === null || v === undefined ? "null" : JSON.stringify(v));
  s = s.replace(/\s+/g, " ").replace(/`/g, "ˋ");          /* a backtick would end the code block */
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE - 1) + "…" : s;
}

function htmlText(s: string): string {
  return s.replace(/[&<>"]/g, function(c: string){ return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[c]; });
}

/* the attribute lines of the diff block */
function diffLines(st: Stop): string[] {
  var r = state.model!.byAddr[st.addr];
  var before: any = r.before || {}, after: any = r.attrs || {}, unknown: any = r.unknown || {};
  var lines: string[] = [];
  if (st.action === "create") {
    Object.keys(after).sort().forEach(function(k: string){
      var v = after[k];
      if (v === null || v === undefined || v === "" || (typeof v === "object" && !Object.keys(v).length) || k === "tags_all") return;
      lines.push("+ " + k + " = " + oneLine(v));
    });
  } else if (st.action !== "delete") {
    var forced = (r.replacePaths || []).map(function(p: any){ return Array.isArray(p) ? String(p[0]) : String(p); });
    var keys = changedKeys(r);
    keys = keys.filter(function(k: string){ return forced.indexOf(k) >= 0; })
      .concat(keys.filter(function(k: string){ return forced.indexOf(k) < 0 && unknown[k] !== true; }))
      .concat(keys.filter(function(k: string){ return forced.indexOf(k) < 0 && unknown[k] === true; }));
    keys.forEach(function(k: string){
      var note = forced.indexOf(k) >= 0 ? "   # forces replacement" : "";
      if (before[k] !== undefined) lines.push("- " + k + " = " + oneLine(valText(before[k], false)));
      lines.push("+ " + k + " = " + (unknown[k] === true ? "(known after apply)" : oneLine(valText(after[k], false))) + note);
    });
  }
  if (lines.length > MAX_LINES) {
    var more = lines.length - MAX_LINES;
    lines = lines.slice(0, MAX_LINES).concat(["  … " + more + " more line" + (more > 1 ? "s" : "")]);
  }
  return lines;
}

/* the crop: centred on the change, kept inside the diagram */
function cropOf(b: Pt, W: number, H: number): Pt {
  var top = PAD + HEAD - 8;
  var w = Math.min(CROP_W, W), h = Math.min(CROP_H, H - top);
  return { x: Math.max(0, Math.min(W - w, b.x + b.w / 2 - w / 2)), y: Math.max(top, Math.min(H - h, b.y + b.h / 2 - h / 2)), w: w, h: h };
}

export function exportDetails(count: number, fonts?: boolean): DetailsExport | null {
  var built = buildSvg({ tour: false, pulse: false, fonts: fonts });
  if (!built || !state.model) return null;
  var w = built.light, model = state.model;
  var order = model.resources.map(function(r){ return r.addr; });
  var rank = function(a: string){ return a in ACTION_RANK ? ACTION_RANK[a] : 4; };
  var all = w.stops.filter(function(s){ return s.action !== "read" && s.action !== "no-op"; })
    .sort(function(a, b){ return rank(a.action) - rank(b.action) || order.indexOf(a.addr) - order.indexOf(b.addr); });
  var picked = all.slice(0, Math.max(0, count));
  var bg = (w.head[0] || "").match(/fill="([^"]*)"/);
  /* the entries of out a crop needs: boxes that reach into it, and everything that is not a box (the lines) */
  var inCrop = function(c: Pt): string {
    var skip: Record<number, boolean> = {};
    w.spans.forEach(function(s){
      var b = s.b;
      if (b.x > c.x + c.w || b.x + b.w < c.x || b.y > c.y + c.h || b.y + b.h < c.y)
        for (var i = s.from; i < s.to; i++) skip[i] = true;
    });
    return w.out.filter(function(_o, i){ return !skip[i]; }).join("\n");
  };
  var files: { name: string; svg: string }[] = [];
  var md: string[] = [];
  var items: DetailsItem[] = [];
  if (!picked.length) return { markdown: "", files: [], items: items, total: all.length };
  md.push("#### Changes" + (all.length > picked.length ? " (" + picked.length + " of " + all.length + ")" : ""));
  picked.forEach(function(st, n){
    var b = st.b;
    var c = cropOf(b, w.W, w.H);
    var ring = '<rect x="' + round(b.x - 5) + '" y="' + round(b.y - 5) + '" width="' + round(b.w + 10) + '" height="' + round(b.h + 10) +
      '" rx="13" fill="none" stroke-width="3" stroke="' + st.colRef + '"/>';
    var crop = built!.map(
      '<rect x="' + round(c.x) + '" y="' + round(c.y) + '" width="' + round(c.w) + '" height="' + round(c.h) + '" rx="10" fill="' + (bg ? bg[1] : "#fff") + '"/>' +
      inCrop(c) + ring);
    files.push({ name: n + ".svg", svg: crop });   /* the css is added below, once every colour is mapped */

    var r = model.byAddr[st.addr];
    var reason = reasonText(r);
    var lines = diffLines(st);
    items.push({ action: st.action, addr: st.addr, title: st.title, reasonHtml: reason, lines: lines, file: n });
    md.push("<details><summary><b>" + st.action.toUpperCase() + "</b> <code>" + htmlText(st.addr) + "</code> · " + htmlText(st.title) + "</summary>");
    md.push("");
    md.push("![" + st.action + " " + n + "](@@IMG" + n + "@@)");
    md.push("");
    if (reason) { md.push(reason); md.push(""); }   /* reasonText is escaped HTML already */
    else if (st.action === "delete") { md.push("Will be destroyed."); md.push(""); }
    if (lines.length) { md.push("```diff"); md = md.concat(lines); md.push("```"); md.push(""); }
    md.push("</details>");
    md.push("");
  });
  var css = built.css, defs = built.defs;
  files.forEach(function(f, n){
    var c = cropOf(picked[n].b, w.W, w.H);
    f.svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(c.w) + '" height="' + Math.round(c.h) +
      '" viewBox="' + round(c.x) + " " + round(c.y) + " " + round(c.w) + " " + round(c.h) + '">' +
      "<style>" + css + "</style>" + defs + f.svg + "</svg>";
  });
  return { markdown: md.join("\n"), files: files, items: items, total: all.length };
}
