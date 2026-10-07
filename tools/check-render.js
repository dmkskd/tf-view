// check-render.js — does the page actually render when a plan is loaded?
//
// WHAT IT CHECKS
//   Loads index.html in a real DOM (jsdom), clicks through the toolbar and
//   asserts what reaches the document: tiles on the canvas, rows in the type
//   list, the detail pane on selection, and the text view. Any exception the
//   page throws — including one thrown inside an event handler, which leaves
//   the page half-rendered and the controls looking dead — fails the run.
//
//   check-boot.js runs the script against a stub DOM, so it catches a failure
//   during start-up only. Everything after the first click is this file.
//
// HOW TO USE IT
//   node tools/check-render.js          exits non-zero on an error
const fs = require("fs");
const { JSDOM } = require("jsdom");

const defaultPath = fs.existsSync(__dirname + "/../dist/index.html")
  ? __dirname + "/../dist/index.html"
  : __dirname + "/../index.html";
const file = process.argv[2] || defaultPath;
const errs = [];
const dom = new JSDOM(fs.readFileSync(file, "utf8"), {
  runScripts: "dangerously", pretendToBeVisual: true, url: "file:///app/index.html"
});
const { window } = dom;
const doc = window.document;
dom.virtualConsole.on("jsdomError", e => errs.push(e.stack || e.message));
window.addEventListener("error", e => errs.push(e.message));

const click = id => {
  const el = doc.getElementById(id);
  if (!el) return errs.push("no such element: " + id);
  try { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }
  catch (e) { errs.push(`click ${id}: ${e.stack.split("\n").slice(0, 3).join(" | ")}`); }
};
const count = sel => doc.querySelectorAll(sel).length;

const checks = [];
const expect = (what, cond, saw) => checks.push({ what, ok: !!cond, saw });

setTimeout(() => {
  const emptySampleBtn = doc.getElementById("emptySampleBtn");
  expect("empty-state sample button available", emptySampleBtn && !emptySampleBtn.disabled,
         emptySampleBtn ? emptySampleBtn.disabled : "missing");
  click("emptySampleBtn");
  expect("tiles drawn", count(".node") > 0, count(".node"));
  expect("containers drawn", count(".grp") > 0, count(".grp"));
  expect("type list filled", count(".flt") > 0, count(".flt"));
  expect("plan header filled", doc.getElementById("srcName").textContent !== "no plan loaded",
         doc.getElementById("srcName").textContent);

  const diagText = doc.getElementById("diag").textContent;
  expect("diagnostics render emphasis, not raw markers", diagText.length > 0 && !diagText.includes("**"), diagText.trim().slice(0, 60));

  const tile = doc.querySelector(".node");
  if (tile) tile.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  expect("detail pane filled", doc.getElementById("detail").innerHTML.length > 200,
         doc.getElementById("detail").innerHTML.length);

  click("modeChg");
  expect("changes mode keeps the tiles", count(".node") > 0, count(".node"));
  click("modeChg");

  click("renderIso");
  expect("isometric keeps the tiles", count(".node") > 0, count(".node"));
  click("renderText");
  expect("text view writes the plan", doc.getElementById("textPlan").textContent.length > 200,
         doc.getElementById("textPlan").textContent.length);
  click("renderFlat");

  /* hovering a rule list shows its rules: the card is drawn by core from the
     provider's rule data, so this covers the provider -> core -> markup path */
  const hover = sel => {
    const el = doc.querySelector(sel);
    if (el) el.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
    return !!el;
  };
  const pop = () => doc.getElementById("rulePop");
  const sgFound = hover('#canvasWrap [data-addr^="aws_security_group."]');
  setTimeout(() => {
    const p = pop();
    expect("security group hover card lists its rules",
           sgFound && p && !p.hidden && /security group/.test(p.textContent) && p.querySelectorAll(".rp-rule").length > 0,
           p ? p.querySelectorAll(".rp-rule").length : "no card");
    const naclFound = hover('#canvasWrap [data-addr^="aws_network_acl."]');
    setTimeout(() => {
      const q = pop();
      const rows = q ? [...q.querySelectorAll(".rp-rule")] : [];
      expect("network ACL hover card ends each direction with the implicit deny",
             naclFound && /network acl/.test(q.textContent) &&
             rows.filter(r => r.classList.contains("deny") && /0\.0\.0\.0\/0/.test(r.textContent)).length >= 2,
             rows.length);
      brokenFile();
    }, 400);
  }, 400);
}, 250);

/* A file that is not JSON: the error shows as text with the message in bold,
   never as markup (the plan file is untrusted). */
function brokenFile() {
  const input = doc.getElementById("fileInput");
  const file = new window.File(['{"a": 1 & <b>x</b>'], "broken.json", { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  setTimeout(() => {
    const d = doc.getElementById("diag");
    const b = d.querySelector(".dg.err b");
    expect("a file that is not JSON gets a plain-text error, message in bold",
           /Could not parse this file as JSON/.test(d.textContent) && b && !/[<>]|&amp;/.test(d.textContent.replace(b.textContent, "")) &&
           !d.querySelector(".dg.err b b") && !d.textContent.includes("<b>"),
           d.textContent.trim().slice(0, 80));
    finish();
  }, 200);
}

function finish() {
  const failed = checks.filter(c => !c.ok);
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.what}  (${c.saw})`);
  if (errs.length) {
    console.error("\nthe page threw:\n" + errs.map(e => "  " + String(e).split("\n").slice(0, 4).join("\n  ")).join("\n---\n"));
  }
  console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed, ${errs.length} errors`);
  process.exit(failed.length || errs.length ? 1 : 0);
}
