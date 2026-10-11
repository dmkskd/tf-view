// ui/svgexport.ts — the flat diagram as one self-contained SVG file
//
// Draws what the canvas shows, read back from the rendered page: every box,
// icon and line of text is placed where the browser laid it out, so the SVG
// matches the page without a second layout. Made for places that show an
// image and nothing more (a pull request comment):
//   - colours for both themes, switched by prefers-color-scheme inside the SVG
//   - the fonts the canvas uses, embedded (font-src data: only)
//   - changed resources pulse (CSS animation, which runs in an <img>)
//   - a <title> per resource: a tooltip when the SVG is opened on its own
//   - a guided tour: the view zooms to each change in turn, with a caption
//     (CSS keyframes on one group; off with tour:false or reduced motion)
// With pulse:false and tour:false nothing moves: changes keep a still outline.
// No script and no external reference, so the file shows the same as an <img>.
import { $, escapeHtml } from "../core/util.js";
import { changedKeys } from "../core/diff.js";
import { state } from "../core/state.js";

export const PAD = 16;
export const HEAD = 30;            /* the plan line above the diagram */
const NS_SKIP = /\bfc\b/;   /* the isometric side faces */

/* the tour, in seconds: overview, move to a stop, stay there */
const T_OVERVIEW = 1.8, T_MOVE = 0.7, T_HOLD = 2.0, T_END = 3.0;
const MAX_STOPS = 8;        /* default number of stops */
/* the order of the stops: what is lost first, then what is changed in place, then what is added */
export const ACTION_RANK: Record<string, number> = { "delete": 0, replace: 1, update: 2, create: 3 };
const MAX_ZOOM = 2.4;
const CAP_H = 66;           /* the caption card, before it is scaled */
export const CAP_REF = 820;        /* the caption reads at 1:1 in an image this wide; wider images scale it up */

export interface Pt { x: number; y: number; w: number; h: number; }

/* a changed resource on the canvas; i is its draw order, and its content
   sits in <g class="rs{i}"> for an animation style to address */
export interface Stop { i: number; addr: string; b: Pt; title: string; sub: string; action: string; colour: string; colRef: string; }

/* Another way to animate the diagram (svgreplay.ts registers "replay").
   It runs at the end of each walk and adds to w.out, w.caps and w.css. */
export type SvgStyle = (w: Walk) => void;
var STYLES: Record<string, SvgStyle> = {};
export function registerSvgStyle(name: string, fn: SvgStyle): void { STYLES[name] = fn; }

export interface SvgExportOptions {
  fonts?: boolean;          /* embed the canvas fonts (default true, about 70 KB) */
  pulse?: boolean;          /* the changed resources' outline pulses (default true); false keeps it still */
  tour?: boolean;           /* zoom to each change in turn (default true) */
  tourStops?: number;       /* how many changes the tour visits (default MAX_STOPS; 0: no tour) */
  tourDelay?: number;       /* seconds on the overview before the first tour starts (default 0) */
  style?: string;           /* the animation: "tour" (default) or a registered style */
}

/* One walk of the canvas. Colours are written as placeholders, recorded in
   order; a second walk in the other theme supplies their dark values. */
export class Walk {
  head: string[] = [];      /* background and plan line: they stay put during the tour */
  out: string[] = [];       /* the diagram: what the tour moves */
  caps: string[] = [];      /* the tour's captions */
  css: string[] = [];       /* the tour's keyframes */
  stops: Stop[] = [];
  spans: { from: number; to: number; b: Pt }[] = [];   /* which entries of out draw which box */
  colours: string[] = [];
  symbols: Record<string, boolean> = {};
  families: Record<string, boolean> = {};
  clipN = 0;
  measure: CanvasRenderingContext2D | null;
  origin: DOMRect;
  scale: number;
  W: number;
  H: number;
  strip = 0;                /* the band under the diagram for the tour's captions */

  constructor(public canvas: HTMLElement, public opts: SvgExportOptions) {
    this.origin = canvas.getBoundingClientRect();
    this.scale = this.origin.width / (canvas.offsetWidth || 1) || 1;
    this.W = Math.ceil(canvas.offsetWidth + PAD * 2);
    this.H = Math.ceil(canvas.offsetHeight + PAD * 2 + HEAD);
    var c = document.createElement("canvas");
    this.measure = c.getContext("2d");
  }

  c(v: string): string {
    this.colours.push(v);
    return "@@C" + (this.colours.length - 1) + "@@";
  }

  box(r: DOMRect): Pt {
    return {
      x: (r.left - this.origin.left) / this.scale + PAD,
      y: (r.top - this.origin.top) / this.scale + PAD + HEAD,
      w: r.width / this.scale, h: r.height / this.scale
    };
  }

  run(): void {
    var self = this, cv = this.canvas;
    var grps = Array.prototype.slice.call(cv.querySelectorAll(":scope > .grp")) as HTMLElement[];
    var nodes = Array.prototype.slice.call(cv.querySelectorAll(":scope > .node")) as HTMLElement[];
    var bg = getComputedStyle($("canvasWrap") || document.body).backgroundColor;
    this.head.push('<rect width="100%" height="100%" rx="10" fill="' + this.c(bg) + '"/>');
    this.header();
    grps.forEach(function(g){ self.item(g); });
    this.edges();
    nodes.forEach(function(n){ self.item(n); });
    if (this.opts.tour === false) return;
    var style = this.opts.style && STYLES[this.opts.style];
    if (style) style(this); else this.tour();
  }

  /* "tf view · <plan label>" and a pill per action the plan takes */
  header(): void {
    var root = getComputedStyle(document.documentElement);
    var tok = function(n: string){ return root.getPropertyValue(n).trim(); };
    var y = PAD + 14, x = PAD;
    var label = (state.model && state.model.source) || "";
    var parts: [string, string, string][] = [["tf view", "700", tok("--ink")]];
    if (label) parts.push(["\u00b7 " + label, "500", tok("--muted")]);
    var self = this;
    parts.forEach(function(p){
      var font = p[1] + " 13px Archivo";
      self.families["Archivo|" + p[1]] = true;
      self.head.push('<text x="' + round(x) + '" y="' + y + '" font-family="Archivo, sans-serif" font-size="13" font-weight="' + p[1] +
        '" fill="' + self.c(p[2]) + '">' + escapeHtml(p[0]) + "</text>");
      x += self.width(p[0], font, 0) + 8;
    });
    x += 6;
    var S: any = (state.model && state.model.summary) || {};
    [["create", "--create"], ["update", "--update"], ["replace", "--replace"], ["delete", "--destroy"]].forEach(function(a){
      var n = S[a[0]] || 0;
      if (!n) return;
      var t = n + " to " + a[0], font = "700 10px Archivo";
      var w = self.width(t.toUpperCase(), font, 0.6) + 14, col = tok(a[1]);
      self.families["Archivo|700"] = true;
      self.head.push('<rect x="' + round(x) + '" y="' + (y - 12) + '" width="' + round(w) + '" height="17" rx="8.5" fill="' +
        self.c(col) + '" fill-opacity=".16"/>');
      self.head.push('<text x="' + round(x + 7) + '" y="' + (y) + '" font-family="Archivo, sans-serif" font-size="10" font-weight="700" letter-spacing=".6" fill="' +
        self.c(col) + '">' + escapeHtml(t.toUpperCase()) + "</text>");
      x += w + 6;
    });
  }

  /* a tile or a container: its own <g>, with a tooltip and the pulse */
  item(el: HTMLElement): void {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    var op = parseFloat(cs.opacity);
    var addr = el.dataset.addr;
    var from = this.out.length;
    this.out.push('<g' + (op < 1 ? ' opacity="' + round(op) + '"' : "") + ">");
    if (addr) this.out.push("<title>" + escapeHtml(tooltip(addr)) + "</title>");
    var changed = el.classList.contains("is-changed");
    var b = this.box(el.getBoundingClientRect());
    var col = cs.getPropertyValue("--pulse").trim() || cs.getPropertyValue("--accent").trim();
    var stop = changed && addr && state.model && state.model.byAddr[addr];
    if (stop) {
      var ttl = el.querySelector(".ttl, .grp-lbl"), nm = el.querySelector(".nm"), i = this.stops.length;
      var colRef = this.c(col);
      this.stops.push({ i: i, addr: addr!, b: b, action: state.model!.byAddr[addr!].action, colour: col, colRef: colRef,
        title: (ttl && ttl.textContent || "").trim(), sub: (nm && nm.textContent || "").replace(/\s+/g, " ").trim() });
      this.out.push('<g class="rs rs' + i + '">');
      this.out.push('<rect class="pulse" x="' + round(b.x - 3) + '" y="' + round(b.y - 3) + '" width="' + round(b.w + 6) +
        '" height="' + round(b.h + 6) + '" rx="12" fill="none" stroke-width="2" stroke="' + colRef + '"/>');
    }
    this.element(el);
    if (stop) this.out.push("</g>");
    this.out.push("</g>");
    this.spans.push({ from: from, to: this.out.length, b: b });
  }

  /* The camera: one keyframe animation on the diagram group, a stop per
     change (by ACTION_RANK, then plan order), and a caption per stop that
     shows while the view stays on it. A plan with more changes than stops ends on the
     overview with a card naming the rest, and a ring on each of them. */
  tour(): void {
    var model = state.model;
    var max = this.opts.tourStops === undefined ? MAX_STOPS : this.opts.tourStops;
    if (!model || !this.stops.length || max < 1) return;
    var order = model.resources.map(function(r){ return r.addr; });
    var rank = function(a: string){ return a in ACTION_RANK ? ACTION_RANK[a] : 4; };
    var all = this.stops.slice().sort(function(a, b){
      return rank(a.action) - rank(b.action) || order.indexOf(a.addr) - order.indexOf(b.addr);
    });
    var stops = all.slice(0, max), more = all.slice(max);
    /* changes the plan makes that are not drawn (association resources, hidden types) */
    var S: any = model.summary || {};
    var planned = (S.create || 0) + (S.update || 0) + (S.replace || 0) + (S["delete"] || 0);
    var total = Math.max(planned, all.length), hidden = total - all.length;
    var rest = more.length + hidden;
    var n = stops.length, W = this.W;
    /* captions sit in their own band under the diagram, so they never cover it */
    var k = Math.min(2.2, Math.max(1, W / CAP_REF));
    this.strip = Math.ceil(CAP_H * k + PAD);
    var H = this.H += this.strip;
    var tBack = T_OVERVIEW + n * (T_MOVE + T_HOLD) + T_MOVE;     /* back on the overview */
    var T = tBack + (rest ? T_END : 0);
    var pct = function(t: number){ return (Math.max(0, Math.min(T, t)) / T * 100).toFixed(2) + "%"; };
    /* opacity 0, then 1 from `from` to `to`, then 0 */
    var show = function(name: string, from: number, to: number){
      return "@keyframes " + name + "{0%," + pct(from - 0.1) + "{opacity:0}" + pct(from + 0.25) + "," + pct(to - 0.2) + "{opacity:1}" +
        (to >= T ? "" : pct(to + 0.1) + ",100%{opacity:0}") + "}";
    };
    /* the stop is centred in the diagram's frame, between the plan line and the captions */
    var ax = 0, ay = PAD + HEAD, aw = W, ah = H - ay - this.strip - PAD;
    var cam = ["0%," + pct(T_OVERVIEW) + "{transform:translate(0px,0px) scale(1)}"];
    var self = this;
    var root = getComputedStyle(document.documentElement);
    var tok = function(v: string){ return root.getPropertyValue(v).trim(); };
    stops.forEach(function(st, i){
      var t0 = T_OVERVIEW + i * (T_MOVE + T_HOLD);
      var b = st.b;
      var sc = Math.max(1, Math.min(MAX_ZOOM, aw / (b.w + 440), ah / (b.h + 260)));
      var tx = ax + aw / 2 - (b.x + b.w / 2) * sc, ty = ay + ah / 2 - (b.y + b.h / 2) * sc;
      cam.push(pct(t0 + T_MOVE) + "," + pct(t0 + T_MOVE + T_HOLD) +
        "{transform:translate(" + round(tx) + "px," + round(ty) + "px) scale(" + sc.toFixed(3) + ")}");
      self.css.push(show("cap" + i, t0 + T_MOVE, t0 + T_MOVE + T_HOLD));
      var col = st.colour || tok("--accent");
      self.card("cap" + i, k, tok, col, st.action.toUpperCase(), st.title,
        (i + 1) + " / " + n + (total > n ? " \u00b7 " + total + " changes" : ""), st.addr, self.detail(st));
      self.ring("cap" + i, st.b, col, 3);
    });
    if (rest) {
      cam.push(pct(tBack) + "{transform:translate(0px,0px) scale(1)}");
      this.css.push(show("more", tBack, T));
      var by: Record<string, number> = {};
      more.forEach(function(st){ by[st.action] = (by[st.action] || 0) + 1; });
      var counts = Object.keys(by).sort(function(a, b){ return rank(a) - rank(b); })
        .map(function(a){ return by[a] + " " + a; });
      if (hidden) counts.push(hidden + " not drawn on the diagram");
      this.card("more", k, tok, tok("--accent"), "+" + rest + " MORE",
        "\u2026and " + rest + " more change" + (rest > 1 ? "s" : ""), "", counts.join(" \u00b7 "),
        "open the visual plan to see every change");
      more.forEach(function(st){ self.ring("more", st.b, st.colour || tok("--accent"), 2); });
    }
    cam.push("100%{transform:translate(0px,0px) scale(1)}");
    this.css.push("@keyframes tour{" + cam.join("") + "}");
    /* the delay shows the overview once, before the first loop */
    var len = T.toFixed(2) + "s", wait = " " + Math.max(0, this.opts.tourDelay || 0) + "s infinite}";
    var anim = [".cam{animation:tour " + len + " ease-in-out" + wait];
    stops.forEach(function(_s, i){ anim.push(".cap" + i + "{animation:cap" + i + " " + len + " linear" + wait); });
    if (rest) anim.push(".more{animation:more " + len + " linear" + wait);
    this.css.push("@media (prefers-reduced-motion: no-preference){" + anim.join("") + "}");
  }

  /* what the caption says about a change */
  detail(st: Stop): string {
    var r = state.model!.byAddr[st.addr];
    if (st.action === "create") return st.sub ? "new \u00b7 " + st.sub : "new resource";
    if (st.action === "delete") return "will be destroyed";
    var ck = changedKeys(r);
    var forced = (r.replacePaths || []).map(function(p: any){ return Array.isArray(p) ? String(p[0]) : String(p); });
    /* a replacement is explained by what forces it; the values recomputed with it are only counted */
    var why = ck.filter(function(k: string){ return forced.indexOf(k) >= 0; });
    var rest = ck.length - why.length;
    if (why.length) return "replaced because of: " + why.slice(0, 4).join(", ") + (why.length > 4 ? " +" + (why.length - 4) : "") +
      (rest ? " \u00b7 " + rest + " other value" + (rest > 1 ? "s" : "") + " change" + (rest > 1 ? "" : "s") : "");
    return ck.length
      ? "changes: " + ck.slice(0, 4).join(", ") + (ck.length > 4 ? " +" + (ck.length - 4) : "")
      : "no attribute changes";
  }

  /* a ring around a box, in the moving diagram; `cls` times it */
  ring(cls: string, b: Pt, col: string, sw: number): void {
    this.out.push('<rect class="cap ' + cls + '" x="' + round(b.x - 5) + '" y="' + round(b.y - 5) + '" width="' + round(b.w + 10) +
      '" height="' + round(b.h + 10) + '" rx="13" fill="none" stroke-width="' + sw + '" stroke="' + this.c(col) + '"/>');
  }

  /* The caption card, bottom left, scaled by k: a pill, a title and a count
     on the first line; two lines of monospace under it. */
  card(cls: string, k: number, tok: (v: string) => string, col: string,
       pill: string, title: string, count: string, line2: string, line3: string): void {
    var fAct = "700 10px Archivo", fTtl = "600 13px Archivo", fMono = "400 11px \"IBM Plex Mono\"";
    this.families["Archivo|700"] = true; this.families["Archivo|600"] = true; this.families["IBM Plex Mono|400"] = true;
    var pillW = this.width(pill, fAct, 0.6) + 14;
    var maxW = (this.W - PAD * 4) / k;
    line2 = this.fit(line2, fMono, 0, maxW - 28);
    line3 = this.fit(line3, fMono, 0, maxW - 28);
    var w = Math.min(maxW, Math.max(pillW + this.width(title, fTtl, 0) + this.width(count, fMono, 0) + 52,
      this.width(line2, fMono, 0) + 28, this.width(line3, fMono, 0) + 28));
    var mono = '" font-family="&quot;IBM Plex Mono&quot;, monospace" font-size="11"';
    this.caps.push('<g class="cap ' + cls + '" transform="translate(' + PAD * 2 + "," + round(this.H - this.strip) + ") scale(" + k.toFixed(3) + ')">' +
      '<rect width="' + round(w) + '" height="' + CAP_H + '" rx="10" fill="' + this.c(tok("--surface")) + '" stroke="' + this.c(tok("--line")) + '"/>' +
      '<rect width="4" height="' + CAP_H + '" rx="2" fill="' + this.c(col) + '"/>' +
      '<rect x="14" y="10" width="' + round(pillW) + '" height="17" rx="8.5" fill="' + this.c(col) + '" fill-opacity=".16"/>' +
      '<text x="21" y="22" font-family="Archivo, sans-serif" font-size="10" font-weight="700" letter-spacing=".6" fill="' +
        this.c(col) + '">' + escapeHtml(pill) + "</text>" +
      '<text x="' + round(22 + pillW) + '" y="23" font-family="Archivo, sans-serif" font-size="13" font-weight="600" fill="' +
        this.c(tok("--ink")) + '">' + escapeHtml(title) + "</text>" +
      (count ? '<text x="' + round(w - 14) + '" y="23" text-anchor="end' + mono + ' fill="' + this.c(tok("--faint")) + '">' + escapeHtml(count) + "</text>" : "") +
      '<text x="14" y="42' + mono + ' fill="' + this.c(tok("--muted")) + '">' + escapeHtml(line2) + "</text>" +
      '<text x="14" y="57' + mono + ' fill="' + this.c(tok("--body")) + '">' + escapeHtml(line3) + "</text>" +
      "</g>");
  }

  element(el: Element): void {
    if (el.id === "edges") return;
    if (el instanceof SVGSVGElement) { this.icon(el); return; }
    if (!(el instanceof HTMLElement)) return;
    if (NS_SKIP.test(el.className)) return;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    this.surface(el, cs);
    var self = this;
    Array.prototype.forEach.call(el.childNodes, function(k: Node){
      if (k.nodeType === 3) self.text(k as Text);
      else if (k.nodeType === 1) self.element(k as Element);
    });
  }

  /* background, border, and an inset bar (box-shadow: inset 3px 0 0 colour) */
  surface(el: HTMLElement, cs: CSSStyleDeclaration): void {
    var bg = cs.backgroundColor, bw = parseFloat(cs.borderTopWidth) || 0;
    var hasBg = !transparent(bg);
    /* the four sides; drawn as one rounded rectangle when they are alike, else one line each */
    var sides = (["Top", "Right", "Bottom", "Left"] as const).map(function(k){
      var w = parseFloat((cs as any)["border" + k + "Width"]) || 0, st = (cs as any)["border" + k + "Style"], col = (cs as any)["border" + k + "Color"];
      return { k: k, w: w, st: st, col: col, on: w > 0 && st !== "none" && st !== "hidden" && !transparent(col) };
    });
    var alike = sides.every(function(sd){ return sd.on === sides[0].on && sd.w === sides[0].w && sd.st === sides[0].st && sd.col === sides[0].col; });
    var hasBorder = alike && sides[0].on;
    var someSides = !alike && sides.some(function(sd){ return sd.on; });
    var inset = /inset/.test(cs.boxShadow) ? parseInset(cs.boxShadow) : null;
    if (!hasBg && !hasBorder && !someSides && !inset) return;
    var b = this.box(el.getBoundingClientRect());
    var rx = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, b.h / 2);
    if (hasBg) {
      this.out.push('<rect x="' + round(b.x) + '" y="' + round(b.y) + '" width="' + round(b.w) + '" height="' + round(b.h) +
        '" rx="' + round(rx) + '" fill="' + this.c(bg) + '"/>');
    }
    if (inset && inset.x > 0) {
      var id = "k" + (this.clipN++);
      this.out.push('<clipPath id="' + id + '"><rect x="' + round(b.x) + '" y="' + round(b.y) + '" width="' + round(b.w) +
        '" height="' + round(b.h) + '" rx="' + round(rx) + '"/></clipPath>');
      this.out.push('<rect clip-path="url(#' + id + ')" x="' + round(b.x) + '" y="' + round(b.y) + '" width="' + round(inset.x) +
        '" height="' + round(b.h) + '" fill="' + this.c(inset.colour) + '"/>');
    }
    if (hasBorder) {
      var dash = cs.borderTopStyle === "dashed" ? ' stroke-dasharray="' + round(bw * 4) + " " + round(bw * 3) + '"' : "";
      this.out.push('<rect x="' + round(b.x + bw / 2) + '" y="' + round(b.y + bw / 2) + '" width="' + round(b.w - bw) +
        '" height="' + round(b.h - bw) + '" rx="' + round(Math.max(0, rx - bw / 2)) + '" fill="none" stroke="' +
        this.c(cs.borderTopColor) + '" stroke-width="' + round(bw) + '"' + dash + "/>");
    }
    if (someSides) {
      var self = this;
      sides.forEach(function(sd){
        if (!sd.on) return;
        var h = sd.w / 2, x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y;
        if (sd.k === "Top") { y1 = y2 = b.y + h; }
        else if (sd.k === "Bottom") { y1 = y2 = b.y + b.h - h; }
        else { x1 = x2 = sd.k === "Left" ? b.x + h : b.x + b.w - h; y2 = b.y + b.h; }
        var d = sd.st === "dashed" ? ' stroke-dasharray="' + round(sd.w * 4) + " " + round(sd.w * 3) + '"' :
                sd.st === "dotted" ? ' stroke-dasharray="' + round(sd.w) + " " + round(sd.w * 2) + '"' : "";
        self.out.push('<line x1="' + round(x1) + '" y1="' + round(y1) + '" x2="' + round(x2) + '" y2="' + round(y2) +
          '" stroke="' + self.c(sd.col) + '" stroke-width="' + round(sd.w) + '"' + d + "/>");
      });
    }
  }

  icon(el: SVGSVGElement): void {
    var use = el.querySelector("use");
    var ref = use && (use.getAttribute("href") || use.getAttribute("xlink:href"));
    if (!ref || ref.charAt(0) !== "#") return;
    var b = this.box(el.getBoundingClientRect());
    if (!b.w || !b.h) return;
    this.symbols[ref.slice(1)] = true;
    var cs = getComputedStyle(el);
    this.out.push('<use href="' + escapeHtml(ref) + '" x="' + round(b.x) + '" y="' + round(b.y) + '" width="' + round(b.w) +
      '" height="' + round(b.h) + '" color="' + this.c(cs.color) + '"/>');
  }

  /* One text node: placed where the browser put it, cut with an ellipsis
     where the page cuts it (overflow hidden on itself or a parent). */
  text(t: Text): void {
    var raw = (t.textContent || "").replace(/\s+/g, " ");
    if (!raw.trim()) return;
    var el = t.parentElement;
    if (!el) return;
    var cs = getComputedStyle(el);
    var range = document.createRange();
    range.selectNodeContents(t);
    var rects = range.getClientRects();
    if (!rects.length) return;
    var first = this.box(rects[0]);
    var s = cs.textTransform === "uppercase" ? raw.toUpperCase() : raw;
    /* leading space collapses away at the start of a line box */
    if (/^\s/.test(s) && rects[0].width > 0 && first.x <= this.box(el.getBoundingClientRect()).x + 0.5) s = s.replace(/^\s+/, "");
    var fam = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    this.families[fam + "|" + cs.fontWeight] = true;
    var font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    var ls = parseFloat(cs.letterSpacing) || 0;
    var right = this.clipRight(el);
    s = this.fit(s, font, ls, right - first.x);
    if (!s) return;
    var asc = this.ascent(font, first.h);
    this.out.push('<text x="' + round(first.x) + '" y="' + round(first.y + asc) + '" font-family="' + escapeHtml(cs.fontFamily) +
      '" font-size="' + parseFloat(cs.fontSize) + '" font-weight="' + cs.fontWeight + '"' +
      (ls ? ' letter-spacing="' + round(ls) + '"' : "") + ' fill="' + this.c(cs.color) + '">' + escapeHtml(s) + "</text>");
  }

  /* right edge of the nearest box that clips this text */
  clipRight(el: HTMLElement): number {
    var right = Infinity;
    for (var p: HTMLElement | null = el; p && p !== this.canvas; p = p.parentElement) {
      var cs = getComputedStyle(p);
      if (cs.overflowX !== "visible") {
        var b = this.box(p.getBoundingClientRect());
        right = Math.min(right, b.x + b.w - (parseFloat(cs.paddingRight) || 0) - (parseFloat(cs.borderRightWidth) || 0));
      }
      if (p.classList.contains("node") || p.classList.contains("grp")) break;
    }
    return right;
  }

  width(s: string, font: string, ls: number): number {
    if (!this.measure) return 0;
    this.measure.font = font;
    return this.measure.measureText(s).width + ls * s.length;
  }

  fit(s: string, font: string, ls: number, room: number): string {
    if (!isFinite(room) || this.width(s, font, ls) <= room + 0.5) return s;
    var lo = 0, hi = s.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (this.width(s.slice(0, mid).trimEnd() + "…", font, ls) <= room) lo = mid; else hi = mid - 1;
    }
    return lo ? s.slice(0, lo).trimEnd() + "…" : "";
  }

  /* where the baseline sits in the line box the browser gave the run */
  ascent(font: string, boxH: number): number {
    if (!this.measure) return boxH * 0.8;
    this.measure.font = font;
    var m = this.measure.measureText("Hg");
    var a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
    if (!a) return boxH * 0.8;
    return (boxH - (a + d)) / 2 + a;
  }

  edges(): void {
    var svg = $("edges");
    if (!svg) return;
    var self = this;
    var paths = Array.prototype.slice.call(svg.querySelectorAll("path")) as SVGPathElement[];
    if (!paths.length) return;
    this.out.push('<g transform="translate(' + PAD + "," + (PAD + HEAD) + ')" fill="none">');
    paths.forEach(function(p){
      var cs = getComputedStyle(p);
      self.out.push('<path d="' + escapeHtml(p.getAttribute("d") || "") + '" stroke="' + self.c(cs.stroke) +
        '" stroke-width="' + escapeHtml(p.getAttribute("stroke-width") || "1") + '" stroke-dasharray="' +
        escapeHtml(p.getAttribute("stroke-dasharray") || "") + '" opacity="' + escapeHtml(p.getAttribute("opacity") || "1") + '"/>');
    });
    this.out.push("</g>");
  }
}

export function round(n: number): string { return String(Math.round(n * 10) / 10); }

function transparent(c: string): boolean {
  return !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
}

function parseInset(s: string): { x: number; colour: string } | null {
  var m = s.match(/((?:rgba?|color)\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px/i);
  return m ? { colour: m[1], x: parseFloat(m[2]) } : null;
}

function tooltip(addr: string): string {
  var r = state.model && state.model.byAddr[addr];
  if (!r) return addr;
  var lines = [addr, r.action];
  if (r.action !== "no-op" && r.action !== "read" && r.action !== "create") {
    var ck = changedKeys(r);
    if (ck.length) lines.push("changes: " + ck.join(", "));
  }
  return lines.join("\n");
}

/* The @font-face rules (data: URIs) for the families and weights the text used. */
function fontFaces(used: Record<string, boolean>): string {
  var fams: Record<string, number[]> = {};
  Object.keys(used).forEach(function(k: string){
    var p = k.split("|");
    (fams[p[0]] = fams[p[0]] || []).push(parseInt(p[1], 10) || 400);
  });
  var out: string[] = [];
  Array.prototype.forEach.call(document.styleSheets, function(sheet: CSSStyleSheet){
    var rules: CSSRuleList | null = null;
    try { rules = sheet.cssRules; } catch (e) { return; }
    Array.prototype.forEach.call(rules || [], function(rule: CSSRule){
      if (!(rule instanceof CSSFontFaceRule)) return;
      var fam = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      var weights = fams[fam];
      if (!weights) return;
      var w = rule.style.getPropertyValue("font-weight").split(/\s+/).map(Number);
      var lo = w[0] || 400, hi = w[1] || lo;
      if (!weights.some(function(x: number){ return x >= lo && x <= hi; })) return;
      out.push(rule.cssText);
    });
  });
  return out.join("\n");
}

function symbolDefs(ids: Record<string, boolean>): string {
  return Object.keys(ids).map(function(id: string){
    var s = document.getElementById(id);
    return s ? new XMLSerializer().serializeToString(s).replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, "") : "";
  }).join("");
}

/* Walks the canvas in the given theme. Transitions and animations are held
   off, so computed colours are the theme's and not a value part way through. */
function walkIn(theme: "light" | "dark", canvas: HTMLElement, opts: SvgExportOptions): Walk {
  document.documentElement.setAttribute("data-theme", theme);
  var w = new Walk(canvas, opts);
  w.run();
  return w;
}

/* Both walks, and what turns their colour placeholders into CSS variables. */
export interface Built { light: Walk; css: string; defs: string; map: (s: string) => string; }

export function buildSvg(opts: SvgExportOptions): Built | null {
  var canvas = $("canvas");
  if (!canvas || !state.model) return null;
  var root = document.documentElement;
  var prevTheme = root.getAttribute("data-theme");
  var freeze = document.createElement("style");
  freeze.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
  document.head.appendChild(freeze);
  var light: Walk, dark: Walk;
  try {
    light = walkIn("light", canvas, opts);
    dark = walkIn("dark", canvas, opts);
  } finally {
    if (prevTheme === null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", prevTheme);
    freeze.remove();
  }
  /* (light, dark) pairs become CSS variables; a walk that came out
     different in the dark theme keeps its light colours */
  var same = light.colours.length === dark.colours.length;
  var vars: Record<string, number> = {}, lightCss: string[] = [], darkCss: string[] = [];
  var map = function(str: string): string {
    return str.replace(/@@C(\d+)@@/g, function(_m: string, i: string){
      var a = light.colours[+i], b = same ? dark.colours[+i] : a;
      var key = a + "|" + b;
      if (!(key in vars)) {
        vars[key] = lightCss.length;
        lightCss.push("--c" + vars[key] + ":" + a);
        darkCss.push("--c" + vars[key] + ":" + b);
      }
      return "var(--c" + vars[key] + ")";
    });
  };
  return {
    light: light, map: map,
    defs: "<defs>" + symbolDefs(light.symbols) + "</defs>",
    /* read after every map() call, so it lists every colour used */
    get css() {
      return [
        opts.fonts === false ? "" : fontFaces(light.families),
        "svg{" + lightCss.join(";") + "}",
        "@media (prefers-color-scheme: dark){svg{" + darkCss.join(";") + "}}",
        "text{white-space:pre}",
        /* outlined at rest, so a viewer that does not animate still sees the changes */
        ".pulse{stroke-opacity:.45}",
        opts.pulse === false ? "" : "@media (prefers-reduced-motion: no-preference){.pulse{animation:pulse 2.4s ease-in-out infinite}}",
        "@keyframes pulse{0%,100%{stroke-opacity:.45}50%{stroke-opacity:.08}}",
        /* without animation the tour rests on the overview, captions hidden */
        ".cam{transform-origin:0 0}.cap{opacity:0}"
      ].concat(light.css).join("\n");
    }
  } as Built;
}

export function exportSvg(opts: SvgExportOptions = {}): string | null {
  var built = buildSvg(opts);
  if (!built) return null;
  var light = built.light;
  var framed = light.caps.length > 0;
  var top = PAD + HEAD - 8;
  var w = light.W, h = light.H;
  var parts = light.head.concat(
    framed ? ['<clipPath id="frame"><rect x="0" y="' + top + '" width="' + w + '" height="' + (h - top - light.strip) + '"/></clipPath>',
              '<g clip-path="url(#frame)"><g class="cam">'] : [],
    light.out,
    framed ? ["</g></g>"] : [],
    light.caps);
  var body = built.map(parts.join("\n"));
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">' +
    "<style>" + built.css + "</style>" + built.defs + body + "</svg>";
}
