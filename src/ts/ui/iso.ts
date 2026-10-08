// ui/iso.ts — Isometric 3D projection, camera rotation, pan & zoom controls
import { $ } from "../core/util.js";
import { state, setSuppressClick } from "../core/state.js";

var isoCanvas = $("canvas");
var ISO = {on:false, rx:54, rz:-45, scale:1, px:0, py:0};
var ISO_HOME = {rx:54, rz:-45, scale:1, px:0, py:0};

function applyTransform(): void {
  if (!isoCanvas) isoCanvas = $("canvas");
  var t = "translate(" + ISO.px + "px," + ISO.py + "px) scale(" + ISO.scale + ")";
  if (ISO.on) t += " rotateX(" + ISO.rx + "deg) rotateZ(" + ISO.rz + "deg)";
  if (isoCanvas) isoCanvas.style.transform = t;
}

function fitCanvas(w: number, h: number): void {
  if (!isoCanvas) isoCanvas = $("canvas");
  if (!isoCanvas) return;
  if (!ISO.on){ isoCanvas.style.margin = "20px"; return; }
  var rad = Math.PI / 180;
  var s = Math.SQRT1_2;                        /* 45 degrees about Z */
  var bw = (w + h) * s;
  var bh = (w + h) * s * Math.cos(ISO.rx * rad);
  var padX = Math.max(20, (bw - w) / 2 + 30);
  var padY = Math.max(20, (bh - h) / 2 + 30);
  isoCanvas.style.margin = padY + "px " + padX + "px";
}

function centerScroll(): void {
  var w = $("canvasWrap");
  if (!w) return;
  w.scrollLeft = Math.max(0, (w.scrollWidth - w.clientWidth) / 2);
  w.scrollTop  = Math.max(0, (w.scrollHeight - w.clientHeight) / 2);
}

function fitView(): void {
  var w = $("canvasWrap");
  if (!isoCanvas) isoCanvas = $("canvas");
  if (!w || !isoCanvas) return;
  var cw = parseFloat(isoCanvas.style.width) || 1;
  var ch = parseFloat(isoCanvas.style.height) || 1;
  var bw = cw, bh = ch;

  if (ISO.on){
    var s = Math.SQRT1_2;
    bw = (cw + ch) * s;
    bh = (cw + ch) * s * Math.cos(ISO.rx * Math.PI / 180);
  }
  /* fit shrinks to fit; it never enlarges, or a small diagram gets blown
     up past its natural size on load */
  ISO.scale = Math.max(0.12, Math.min(1,
    Math.min((w.clientWidth - 48) / bw, (w.clientHeight - 48) / bh)));
  ISO.px = 0; ISO.py = 0;
  applyTransform();
  requestAnimationFrame(centerScroll);
}

/* the rotation takes this long (.canvas.iso in iso.css) */
var ISO_MS = 450;
var isoLeaveTimer: any = null;

/* `persist` false: a change made by a link must not become the viewer's saved choice */
function setIso(on: boolean, persist: boolean = true): void {
  if (!isoCanvas) isoCanvas = $("canvas");
  ISO.on = on;
  var wrap = $("canvasWrap");
  /* The transition rule, the perspective and the 3D faces all hang off the
     `iso` class. Dropping it at once would make the way back snap, so on the
     way out the class stays until the rotation has played. */
  clearTimeout(isoLeaveTimer);
  if (on){
    if (isoCanvas) isoCanvas.classList.add("iso");
    if (wrap) wrap.classList.add("iso");        /* perspective lives here */
  } else {
    isoLeaveTimer = setTimeout(function(){
      if (isoCanvas) isoCanvas.classList.remove("iso");
      if (wrap) wrap.classList.remove("iso");
    }, ISO_MS + 40);
  }
  var pane = $("canvasPane");
  if (pane) pane.classList.toggle("iso", on);   /* the hud reads this      */
  var flatBtn = $("renderFlat");
  if (flatBtn) flatBtn.classList.toggle("on", !on && state.opts.render === "diagram");
  var isoBtn = $("renderIso");
  if (isoBtn) isoBtn.classList.toggle("on", on && state.opts.render === "diagram");
  if (persist) { try { localStorage.setItem("tfplanview-iso", on ? "1" : "0"); } catch(e){} }
  fitCanvas(parseFloat(isoCanvas ? isoCanvas.style.width : "0") || 0, parseFloat(isoCanvas ? isoCanvas.style.height : "0") || 0);
  applyTransform();
  if (state.model) fitView();
}

(function isoControls(): void {
  var wrap = $("canvasWrap");
  if (!wrap) return;
  var drag: any = null;

  wrap.addEventListener("pointerdown", function(e: PointerEvent){
    if (e.button === 2 || !state.model) return;
    drag = {x:e.clientX, y:e.clientY, moved:0,
            /* flat has nothing to orbit, so a drag always pans there */
            pan: !ISO.on || e.shiftKey || e.button === 1,
            rx:ISO.rx, rz:ISO.rz, px:ISO.px, py:ISO.py, active:false};
  });

  window.addEventListener("pointermove", function(e: PointerEvent){
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    if (drag.moved <= 4) return;            /* a click is not a drag */
    if (!drag.active){
      drag.active = true;
      if (wrap) wrap.classList.add("grabbing");
      if (isoCanvas) isoCanvas.classList.add("dragging");
    }
    if (drag.pan){
      ISO.px = drag.px + dx;
      ISO.py = drag.py + dy;
    } else {
      /* CSS +Y points down, so a positive rotateZ reads clockwise on screen:
         negate it so the scene follows the pointer */
      ISO.rz = drag.rz - dx * 0.35;
      ISO.rx = Math.max(20, Math.min(72, drag.rx - dy * 0.3));
    }
    applyTransform();
  });

  function endDrag(): void {
    if (!drag) return;
    var wasDrag = drag.moved > 4;
    drag = null;
    if (wrap) wrap.classList.remove("grabbing");
    if (isoCanvas) isoCanvas.classList.remove("dragging");
    setSuppressClick(wasDrag);
    if (wasDrag) setTimeout(function(){ setSuppressClick(false); }, 0);
    else setSuppressClick(false);
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  wrap.addEventListener("wheel", function(e: WheelEvent){
    if (!state.model) return;
    e.preventDefault();
    var f = Math.exp(-e.deltaY * 0.0015);
    ISO.scale = Math.max(0.2, Math.min(4, ISO.scale * f));
    applyTransform();
  }, {passive:false});

  var resetBtn = $("isoReset");
  if (resetBtn) resetBtn.addEventListener("click", function(e: MouseEvent){
    e.stopPropagation();
    ISO.rx = ISO_HOME.rx; ISO.rz = ISO_HOME.rz;
    ISO.px = 0; ISO.py = 0; ISO.scale = 1;
    applyTransform();
    fitView();
  });
})();

export {
  ISO, ISO_HOME, applyTransform, fitCanvas, centerScroll, fitView, setIso
};
