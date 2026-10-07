import { $, html } from "../core/util.js";
import { cliCommands, consoleLink, toolNames } from "../core/registry.js";
import { state, setSelected } from "../core/state.js";
import { select, render, icoSvg } from "./diagram.js";
import { renderDetail } from "./detail.js";
import { linkTitle } from "../core/links.js";

/* ------------------------------------------------------------------
   Context menu. Actions belong on the resource you are pointing at,
   so everything that acts on one resource lives here rather than in
   the detail pane.
   ------------------------------------------------------------------ */

var ctxEl: HTMLElement | null = $("ctxMenu"), ctxAddr: string | null = null;

function closeCtx(): void {
  if (!ctxEl) ctxEl = $("ctxMenu");
  if (ctxEl) ctxEl.hidden = true;
  ctxAddr = null;
}

function ctxItem(label: string, hint: string, fn: () => void): HTMLButtonElement {
  var b = document.createElement("button");
  b.innerHTML = html`
    ${label}
    ${hint && html`<span class="k">${hint}</span>`}
  `.toString();
  b.addEventListener("click", function(e: MouseEvent){ e.stopPropagation(); closeCtx(); fn(); });
  return b;
}

/* A real anchor, so the browser shows the true destination in its status bar
   and the click is exactly the URL that was validated. */
function ctxLink(label: string, hint: string, href: string, consoleName: string): HTMLAnchorElement {
  var a = document.createElement("a");
  a.innerHTML = html`
    ${label}
    ${hint && html`<span class="k">${hint}</span>`}
  `.toString();
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = linkTitle(href, consoleName);
  a.addEventListener("click", function(e: MouseEvent){ e.stopPropagation(); closeCtx(); });
  return a;
}

function openCtx(addr: string, x: number, y: number): void {
  const model = state.model;
  if (!model) return;
  var r = model.byAddr[addr];
  if (!r) return;
  if (!ctxEl) ctxEl = $("ctxMenu");
  if (!ctxEl) return;
  ctxAddr = addr;
  ctxEl.innerHTML = "";

  var head = document.createElement("div");
  head.className = "ctx-head";
  head.innerHTML = html`
    ${icoSvg(r.spec, 18)}
    <b>${r.addr}</b>
  `.toString();
  ctxEl.appendChild(head);

  ctxEl.appendChild(ctxItem("Open details", "", function(){ select(addr); }));

  var hr1 = document.createElement("hr"); ctxEl.appendChild(hr1);

  ctxEl.appendChild(ctxItem("Hide this resource", "", function(){
    r.hidden = true;
    if (state.selected === addr){ setSelected(null); renderDetail(); }
    render();
  }));
  ctxEl.appendChild(ctxItem("Hide all " + r.type, String(model.typeCounts[r.type] || 1), function(){
    model.resources.forEach(function(x: any){ if (x.type === r.type) x.enabledType = false; });
    render();
  }));

  var anyHidden = model.resources.some(function(x: any){ return x.hidden || x.enabledType === false; });
  if (anyHidden){
    ctxEl.appendChild(ctxItem("Show everything", "", function(){
      model.resources.forEach(function(x: any){ x.hidden = false; x.enabledType = true; });
      render();
    }));
  }

  var hr2 = document.createElement("hr"); ctxEl.appendChild(hr2);

  ctxEl.appendChild(ctxItem("Copy resource address", r.addr.length > 24 ? "\u2026" + r.addr.slice(-23) : r.addr, function(){
    copyTextSilent(r.addr);
  }));
  var tools = toolNames(r);
  var link = consoleLink(r, model);
  if (link){
    ctxEl.appendChild(ctxLink("Open in " + tools.console, "\u2197", link, tools.console));
  }
  var cmds = cliCommands(r, model);
  if (cmds.length){
    ctxEl.appendChild(ctxItem("Copy " + cmds[0].label.toLowerCase() + " command", cmds[0].cmd.split(" ")[0], function(){
      copyTextSilent(cmds[0].cmd);
    }));
  }

  /* place it, keeping the whole menu on screen */
  ctxEl.hidden = false;
  var w = ctxEl.offsetWidth, hgt = ctxEl.offsetHeight;
  ctxEl.style.left = Math.min(x, window.innerWidth  - w - 8) + "px";
  ctxEl.style.top  = Math.min(y, window.innerHeight - hgt - 8) + "px";
}

function copyTextSilent(text: string): void {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text);
      return;
    }
  } catch(e){}
  var ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch(e){}
  ta.remove();
}

var wrapEl = $("canvasWrap");
if (wrapEl){
  wrapEl.addEventListener("contextmenu", function(e: MouseEvent){
    var target = e.target as HTMLElement | null;
    var el = target && target.closest ? (target.closest("[data-addr]") as HTMLElement) : null;
    if (!el || !state.model || !el.dataset.addr) return;
    e.preventDefault();
    openCtx(el.dataset.addr, e.clientX, e.clientY);
  });
  wrapEl.addEventListener("scroll", closeCtx);
}
document.addEventListener("click", function(){ if (ctxEl && !ctxEl.hidden) closeCtx(); });
document.addEventListener("keydown", function(e: KeyboardEvent){ if (e.key === "Escape") closeCtx(); });

export { ctxEl, closeCtx, ctxItem, openCtx };

