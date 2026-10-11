// ui/svgpreview.ts — ?export=svg&preview=1: the SVG export as a comment would show it
//
// The SVG in an <img> (so it behaves as in a pull request comment: animation
// runs, no hover), the per-change sections under it, and a bar of controls.
// It is an overlay on the app: the canvas stays laid out underneath, so a
// control exports again in place (no reload, no navigation).
import { copyText } from "../core/util.js";
import type { DetailsExport } from "./svgdetails.js";

const CSS = [
  ".pv-root{position:fixed;inset:0;z-index:1000;overflow:auto;background:#f6f8fa;color:#1f2328;",
  "  font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5}",
  ".pv-bar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;",
  "  padding:10px 16px;background:#fff;border-bottom:1px solid #d1d9e0}",
  ".pv-bar b{font-weight:600}.pv-bar label{display:inline-flex;gap:6px;align-items:center}",
  ".pv-bar input[type=number]{width:52px}.pv-bar .pv-seg button{border:1px solid #d1d9e0;background:#f6f8fa;padding:3px 10px;cursor:pointer}",
  ".pv-bar .pv-seg button:first-child{border-radius:6px 0 0 6px}.pv-bar .pv-seg button:last-child{border-radius:0 6px 6px 0;border-left:0}",
  ".pv-bar .pv-seg button.on{background:#8C4FFF;border-color:#8C4FFF;color:#fff}",
  ".pv-bar .pv-btn{border:1px solid #d1d9e0;background:#f6f8fa;border-radius:6px;padding:3px 10px;cursor:pointer;color:inherit;text-decoration:none}",
  ".pv-bar .pv-size{margin-left:auto;color:#59636e;font-size:12px}",
  ".pv-wrap{max-width:900px;margin:20px auto;padding:0 16px}",
  ".pv-c{background:#fff;border:1px solid #d1d9e0;border-radius:6px}",
  ".pv-h{padding:8px 16px;border-bottom:1px solid #d1d9e0;background:#f6f8fa;border-radius:6px 6px 0 0;color:#59636e}",
  ".pv-b{padding:16px}.pv-b img{max-width:100%;display:block}.pv-b h3{margin:0 0 12px}.pv-b h4{margin:20px 0 8px}",
  "details{border:1px solid #d1d9e0;border-radius:6px;padding:8px 12px;margin:8px 0}summary{cursor:pointer}",
  "details img{margin:10px 0}details code{background:#eff1f3;padding:1px 4px;border-radius:4px;font-size:12px}",
  "pre.pv-diff{background:#f6f8fa;padding:12px;border-radius:6px;font:12px ui-monospace,Menlo,monospace;overflow:auto;margin:8px 0 0}",
  ".pv-add{color:#116329;background:#dafbe1}.pv-del{color:#82071e;background:#ffebe9}",
  ".pv-note{color:#59636e;font-size:12px;margin-top:10px}",
  ".pv-root.pv-dark{background:#0d1117;color:#e6edf3}.pv-root.pv-dark .pv-bar,.pv-root.pv-dark .pv-c{background:#0d1117;border-color:#3d444d}",
  ".pv-root.pv-dark .pv-h,.pv-root.pv-dark pre.pv-diff{background:#151b23;border-color:#3d444d;color:#9198a1}",
  ".pv-root.pv-dark details{border-color:#3d444d}.pv-root.pv-dark details code{background:#262c36}",
  ".pv-root.pv-dark .pv-bar .pv-seg button,.pv-root.pv-dark .pv-bar .pv-btn{background:#151b23;border-color:#3d444d;color:#e6edf3}",
  ".pv-root.pv-dark .pv-add{color:#3fb950;background:#12261e}.pv-root.pv-dark .pv-del{color:#f85149;background:#25171c}"
].join("\n");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function dataUrl(svg: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function kb(n: number): string { return Math.round(n / 1024) + " KB"; }

function segment(label: string, options: [string, string][], current: string, set: (v: string) => void): HTMLElement {
  var wrap = el("label");
  wrap.appendChild(el("b", "", label));
  var seg = el("span", "pv-seg");
  options.forEach(function(o){
    var b = el("button", o[0] === current ? "on" : "", o[1]);
    b.type = "button";
    b.addEventListener("click", function(){ set(o[0]); });
    seg.appendChild(b);
  });
  wrap.appendChild(seg);
  return wrap;
}

function number(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void): HTMLElement {
  var wrap = el("label");
  wrap.appendChild(el("b", "", label));
  var inp = el("input");
  inp.type = "number"; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(value);
  inp.addEventListener("change", function(){
    var v = Math.max(min, Math.min(max, parseFloat(inp.value) || 0));
    set(v);
  });
  wrap.appendChild(inp);
  return wrap;
}

export interface PreviewSettings { style: string; animate: boolean; tourStops: number; tourDelay: number; details: number; }
export type PreviewMake = (s: PreviewSettings) => { svg: string; details: DetailsExport | null };

export function showSvgPreview(make: PreviewMake, initial: PreviewSettings): void {
  var style = el("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  var root = el("div", "pv-root");
  document.body.appendChild(root);
  var s: PreviewSettings = Object.assign({}, initial);
  var change = function(k: keyof PreviewSettings, v: any){ (s as any)[k] = v; draw(); };

  function draw(): void {
    var out = make(s), svg = out.svg, details = out.details;
    var bar = el("div", "pv-bar");
    bar.appendChild(segment("Style", [["tour", "Tour"], ["replay", "Replay"]], s.style, function(v){ change("style", v); }));
    bar.appendChild(segment("Animation", [["1", "On"], ["0", "Off"]], s.animate ? "1" : "0", function(v){ change("animate", v === "1"); }));
    if (s.style === "tour") bar.appendChild(number("Stops", s.tourStops, 0, 20, 1, function(v){ change("tourStops", v); }));
    bar.appendChild(number("Delay (s)", s.tourDelay, 0, 60, 0.5, function(v){ change("tourDelay", v); }));
    bar.appendChild(number("Sections", s.details, 0, 20, 1, function(v){ change("details", v); }));

    var img = el("img");
    img.alt = "Visual plan";
    var src = dataUrl(svg);
    img.src = src;
    var restart = el("button", "pv-btn", "Restart");
    restart.type = "button";
    /* a new address starts the animation from zero */
    restart.addEventListener("click", function(){ img.src = src + "#" + Date.now(); });
    bar.appendChild(restart);
    var copy = el("button", "pv-btn", "Copy SVG");
    copy.type = "button";
    copy.addEventListener("click", function(){ copyText(svg, copy); });
    bar.appendChild(copy);
    var dark = el("button", "pv-btn", "Page: light / dark");
    dark.type = "button";
    dark.title = "The page around the image. The image itself follows your system's light or dark setting.";
    dark.addEventListener("click", function(){ root.classList.toggle("pv-dark"); });
    bar.appendChild(dark);
    var crops = details ? details.files.reduce(function(a, f){ return a + f.svg.length; }, 0) : 0;
    bar.appendChild(el("span", "pv-size", "image " + kb(svg.length) + (details && details.files.length ? " \u00b7 " + details.files.length + " crops " + kb(crops) : "")));
    var body = el("div", "pv-b");
    body.appendChild(el("h3", "", "Visual plan"));
    body.appendChild(img);
    if (details && details.items.length) {
      body.appendChild(el("h4", "", "Changes" + (details.total > details.items.length ? " (" + details.items.length + " of " + details.total + ")" : "")));
      details.items.forEach(function(it){
        var d = el("details");
        var sum = el("summary");
        sum.appendChild(el("b", "", it.action.toUpperCase()));
        sum.appendChild(document.createTextNode(" "));
        sum.appendChild(el("code", "", it.addr));
        sum.appendChild(document.createTextNode(" · " + it.title));
        d.appendChild(sum);
        var crop = el("img");
        crop.alt = it.action + " " + it.addr;
        crop.src = dataUrl(details!.files[it.file].svg);
        d.appendChild(crop);
        if (it.reasonHtml) {
          var p = el("p");
          p.innerHTML = it.reasonHtml;   /* reasonText escapes everything it takes from the plan */
          d.appendChild(p);
        } else if (it.action === "delete") d.appendChild(el("p", "", "Will be destroyed."));
        if (it.lines.length) {
          var pre = el("pre", "pv-diff");
          it.lines.forEach(function(l){
            pre.appendChild(el("span", l.charAt(0) === "+" ? "pv-add" : l.charAt(0) === "-" ? "pv-del" : "", l));
            pre.appendChild(document.createTextNode("\n"));
          });
          d.appendChild(pre);
        }
        body.appendChild(d);
      });
    }
    var card = el("div", "pv-c");
    card.appendChild(el("div", "pv-h", "Pull request comment (preview)"));
    card.appendChild(body);
    var wrap = el("div", "pv-wrap");
    wrap.appendChild(card);
    wrap.appendChild(el("div", "pv-note",
      "The image is shown as an <img>, as GitHub and GitLab show it: animation runs, hover and links do not. " +
      "Restart replays the animation from the beginning."));
    root.replaceChildren(bar, wrap);
  }
  draw();
}
