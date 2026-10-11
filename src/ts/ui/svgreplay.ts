// ui/svgreplay.ts — the "replay" animation style for the SVG export
//
// Plays the plan as an apply would: the diagram starts in the prior state
// (resources to create hidden), then each change happens in turn.
//   delete    fades and is struck through (dependents first, before anything is built)
//   replace   blinks out and back, with a ring
//   update    flashes a ring
//   create    pops in (dependencies first)
// A band under the diagram names the step and fills a progress bar. The
// picture at rest (no animation, reduced motion) is the planned state.
// The order follows the references between changed resources; Terraform's
// real apply runs independent changes in parallel, so this is one valid order.
import { registerSvgStyle, round, PAD, CAP_REF, type Walk, type Stop } from "./svgexport.js";
import { escapeHtml } from "../core/util.js";
import { state } from "../core/state.js";

/* seconds: the prior state, one step (scaled to the number of changes), the planned state */
const T_BEFORE = 1.6, T_AFTER = 3.2, STEP_MIN = 0.35, STEP_MAX = 1.1, STEPS_IN = 9;
const BAND_H = 40;

/* Kahn's algorithm over the references between the given changes, keeping
   plan order among those that are ready together. */
function dependencyOrder(list: Stop[]): Stop[] {
  var model = state.model!;
  var order = model.resources.map(function(r){ return r.addr; });
  var byAddr: Record<string, Stop> = {};
  list.forEach(function(s){ byAddr[s.addr] = s; });
  var deps: Record<string, string[]> = {};
  list.forEach(function(s){
    var r = model.byAddr[s.addr];
    var out: string[] = [];
    (r ? r.refs : []).forEach(function(ref: string){
      list.forEach(function(o){
        if (o.addr !== s.addr && (o.addr === ref || o.addr.indexOf(ref + "[") === 0) && out.indexOf(o.addr) < 0) out.push(o.addr);
      });
    });
    deps[s.addr] = out;
  });
  var done: Record<string, boolean> = {}, result: Stop[] = [];
  var pending = list.slice().sort(function(a, b){ return order.indexOf(a.addr) - order.indexOf(b.addr); });
  while (pending.length) {
    var next = pending.filter(function(s){ return deps[s.addr].every(function(d){ return done[d]; }); });
    if (!next.length) next = [pending[0]];   /* a cycle: take the first and go on */
    next.forEach(function(s){ done[s.addr] = true; result.push(s); });
    pending = pending.filter(function(s){ return !done[s.addr]; });
  }
  return result;
}

function replay(w: Walk): void {
  var model = state.model;
  if (!model || !w.stops.length) return;
  var acts = w.stops.filter(function(s){ return s.action !== "read" && s.action !== "no-op"; });
  /* destroys first, dependents before what they use; then everything else, dependencies first */
  var seq = dependencyOrder(acts.filter(function(s){ return s.action === "delete"; })).reverse()
    .concat(dependencyOrder(acts.filter(function(s){ return s.action !== "delete"; })));
  var n = seq.length;
  if (!n) return;
  var S: any = model.summary || {};
  var planned = (S.create || 0) + (S.update || 0) + (S.replace || 0) + (S["delete"] || 0);
  var hidden = Math.max(0, planned - n);
  var step = Math.max(STEP_MIN, Math.min(STEP_MAX, STEPS_IN / n));
  var tEnd = T_BEFORE + n * step, T = tEnd + T_AFTER;
  var pct = function(t: number){ return (Math.max(0, Math.min(T, t)) / T * 100).toFixed(2) + "%"; };
  var root = getComputedStyle(document.documentElement);
  var tok = function(v: string){ return root.getPropertyValue(v).trim(); };
  var ACT: Record<string, string> = { create: "--create", update: "--update", replace: "--replace", "delete": "--destroy" };

  var k = Math.min(2.2, Math.max(1, w.W / CAP_REF));
  w.strip = Math.ceil(BAND_H * k + PAD);
  w.H += w.strip;

  var base: string[] = [".rs{transform-box:fill-box;transform-origin:center}"];
  var keys: string[] = [], run: string[] = [];
  var anim = function(cls: string, frames: string, ease: string){
    keys.push("@keyframes " + cls + "{" + frames + "}");
    run.push("." + cls + "{animation:" + cls + " " + T.toFixed(2) + "s " + ease + " " +
      Math.max(0, w.opts.tourDelay || 0) + "s infinite backwards}");
  };
  /* rings and strikes, over the diagram */
  var ring = function(s: Stop, cls: string){
    var b = s.b;
    w.out.push('<rect class="' + cls + '" x="' + round(b.x - 5) + '" y="' + round(b.y - 5) + '" width="' + round(b.w + 10) +
      '" height="' + round(b.h + 10) + '" rx="13" fill="none" stroke-width="3" stroke="' + s.colRef + '"/>');
  };

  seq.forEach(function(s, j){
    var t = T_BEFORE + j * step, rs = "rs" + s.i, x = "x" + s.i;
    var flash = Math.max(step, 0.8);
    if (s.action === "create") {
      anim(rs, "0%," + pct(t) + "{opacity:0;transform:scale(.82)}" + pct(t + 0.4) + ",100%{opacity:1;transform:scale(1)}", "ease-out");
    } else if (s.action === "delete") {
      base.push("." + rs + "{opacity:.22}");
      anim(rs, "0%," + pct(t) + "{opacity:1}" + pct(t + 0.4) + ",100%{opacity:.22}", "ease-in-out");
      var b = s.b, my = b.y + Math.min(b.h / 2, 18);
      w.out.push('<line class="' + x + '" x1="' + round(b.x - 4) + '" y1="' + round(my) + '" x2="' + round(b.x + b.w + 4) + '" y2="' + round(my) +
        '" stroke-width="2.5" stroke-linecap="round" stroke="' + s.colRef + '"/>');
      anim(x, "0%," + pct(t) + "{opacity:0}" + pct(t + 0.3) + ",100%{opacity:1}", "ease-out");
    } else {
      if (s.action === "replace")
        anim(rs, "0%," + pct(t) + "{opacity:1}" + pct(t + 0.25) + "{opacity:.1}" + pct(t + 0.6) + ",100%{opacity:1}", "ease-in-out");
      ring(s, x);
      base.push("." + x + "{opacity:0}");
      anim(x, "0%," + pct(t) + "{opacity:0}" + pct(t + 0.15) + "{opacity:1}" + pct(t + flash) + ",100%{opacity:0}", "ease-out");
    }
  });

  /* the band: one line per step (and before / after), a progress bar under it */
  var fPill = "700 10px Archivo", fTtl = "600 12px Archivo", fMono = "400 11px \"IBM Plex Mono\"";
  w.families["Archivo|700"] = true; w.families["Archivo|600"] = true; w.families["IBM Plex Mono|400"] = true;
  var bw = (w.W - PAD * 4) / k;
  var mono = ' font-family="&quot;IBM Plex Mono&quot;, monospace" font-size="11"';
  var line = function(cls: string, pill: string, col: string, title: string, rest: string, count: string): string {
    var pw = w.width(pill, fPill, 0.6) + 14;
    var tw = w.width(title, fTtl, 0);
    var cw = count ? w.width(count, fMono, 0) + 12 : 0;
    var rx = pw + 8 + tw + 10;
    rest = w.fit(rest, fMono, 0, bw - rx - cw);
    return '<g class="' + cls + '">' +
      '<rect y="2" width="' + round(pw) + '" height="17" rx="8.5" fill="' + w.c(col) + '" fill-opacity=".16"/>' +
      '<text x="7" y="14" font-family="Archivo, sans-serif" font-size="10" font-weight="700" letter-spacing=".6" fill="' + w.c(col) + '">' +
        escapeHtml(pill) + "</text>" +
      '<text x="' + round(pw + 8) + '" y="15" font-family="Archivo, sans-serif" font-size="12" font-weight="600" fill="' + w.c(tok("--ink")) + '">' +
        escapeHtml(title) + "</text>" +
      '<text x="' + round(rx) + '" y="15"' + mono + ' fill="' + w.c(tok("--muted")) + '">' + escapeHtml(rest) + "</text>" +
      (count ? '<text x="' + round(bw) + '" y="15" text-anchor="end"' + mono + ' fill="' + w.c(tok("--faint")) + '">' + escapeHtml(count) + "</text>" : "") +
      "</g>";
  };
  var band: string[] = [];
  band.push(line("rcb", "BEFORE", tok("--noop"), "prior state", "", ""));
  base.push(".rcb{opacity:0}");
  anim("rcb", "0%," + pct(T_BEFORE - 0.05) + "{opacity:1}" + pct(T_BEFORE) + ",100%{opacity:0}", "linear");
  seq.forEach(function(s, j){
    var t = T_BEFORE + j * step, cls = "rc" + j;
    band.push(line(cls, s.action.toUpperCase(), tok(ACT[s.action] || "--accent"), s.title, s.addr, (j + 1) + " / " + n));
    base.push("." + cls + "{opacity:0}");
    anim(cls, "0%," + pct(t - 0.01) + "{opacity:0}" + pct(t) + "," + pct(t + step - 0.01) + "{opacity:1}" + pct(t + step) + ",100%{opacity:0}", "linear");
  });
  var after = n + " change" + (n > 1 ? "s" : "") + " applied" + (hidden ? " · " + hidden + " more not drawn on the diagram" : "");
  band.push(line("rca", "AFTER", tok("--accent"), "planned state", after, ""));
  anim("rca", "0%," + pct(tEnd - 0.01) + "{opacity:0}" + pct(tEnd) + ",100%{opacity:1}", "linear");
  /* progress: track and fill */
  band.push('<rect y="28" width="' + round(bw) + '" height="4" rx="2" fill="' + w.c(tok("--line")) + '"/>');
  band.push('<rect class="pb" y="28" width="' + round(bw) + '" height="4" rx="2" fill="' + w.c(tok("--accent")) + '"/>');
  base.push(".pb{transform-box:fill-box;transform-origin:0 50%}");
  anim("pb", "0%," + pct(T_BEFORE) + "{transform:scaleX(0)}" + pct(tEnd) + ",100%{transform:scaleX(1)}", "linear");

  w.caps.push('<g transform="translate(' + PAD * 2 + "," + round(w.H - w.strip) + ") scale(" + k.toFixed(3) + ')">' + band.join("") + "</g>");
  w.css.push(base.join(""), keys.join("\n"), "@media (prefers-reduced-motion: no-preference){" + run.join("") + "}");
}

registerSvgStyle("replay", replay);
