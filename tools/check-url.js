// check-url.js — does a link open the view it asks for?
//
// WHAT IT CHECKS
//   Loads the built page in jsdom at addresses such as ?sample=webapp&view=3d&changes=1&select=aws_lb.app
//   and reads what ended up on the page: which plan, which view, whether changes are marked, what is
//   selected. Also that bad links change nothing, that a report with its own plan ignores `sample`,
//   and that a link does not overwrite the viewer's saved 3D choice. The parsing rules themselves are
//   tested in tools/test.js ("links: the page address can ask for a view").
//
// HOW TO USE IT
//   node tools/check-url.js      exits non-zero if a check fails
const fs = require("fs");
const { JSDOM } = require("jsdom");

const file = fs.existsSync(__dirname + "/../dist/index.html") ? __dirname + "/../dist/index.html" : __dirname + "/../index.html";
const HTML = fs.readFileSync(file, "utf8");

const open = (search, html = HTML) => new Promise(resolve => {
  const errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/index.html" + search });
  dom.virtualConsole.on("jsdomError", e => errs.push(e.message));
  dom.window.addEventListener("error", e => errs.push(e.message));
  setTimeout(() => resolve({ win: dom.window, doc: dom.window.document, errs }), 300);
});

/* what is on the page */
const look = ({ win, doc }) => ({
  plan: doc.getElementById("srcName").textContent.replace(/\s+/g, " ").trim(),
  iso: doc.getElementById("renderIso").classList.contains("on"),
  flat: doc.getElementById("renderFlat").classList.contains("on"),
  text: doc.getElementById("renderText").classList.contains("on") && !doc.getElementById("textView").hidden,
  changes: doc.getElementById("modeChg").getAttribute("aria-pressed") === "true",
  selected: doc.querySelectorAll(".node.sel").length,
  tiles: doc.querySelectorAll(".node").length,
  savedIso: (() => { try { return win.localStorage.getItem("tfplanview-iso"); } catch (e) { return "n/a"; } })()
});

/* a report with its own plan, as the tfview CLI writes it */
const fill = (html, id, text) => html.replace(
  new RegExp(`(<script type="application/json" id="${id}">)[\\s\\S]*?(</script>)`),
  (_, a, b) => a + text.replace(/</g, "\\u003c") + b);
const block = id => { const t = `<script type="application/json" id="${id}">`; const i = HTML.indexOf(t) + t.length; return HTML.slice(i, HTML.indexOf("</script>", i)); };
const REPORT = fill(fill(HTML, "injected-plan", block("embedded-plan")), "tfview-config",
                    JSON.stringify({ autoload: true, viewerOnly: true, label: "MY REPORT" }));

const results = [];
const check = (what, cond, saw) => results.push({ what, ok: !!cond, saw });

(async () => {
  let r, v;

  r = await open(""); v = look(r);
  check("no parameters: the empty page, as before", /no plan loaded/.test(v.plan) && v.tiles === 0, v.plan);
  check("no parameters: no errors", r.errs.length === 0, r.errs);

  r = await open("?sample=webapp&view=3d&changes=1&select=aws_lb.app"); v = look(r);
  check("full link: the web app sample", /full-stack/.test(v.plan), v.plan);
  check("full link: 3D view", v.iso && !v.flat, v);
  check("full link: changes marked", v.changes, v.changes);
  check("full link: one tile selected", v.selected === 1, v.selected);
  check("full link: no errors", r.errs.length === 0, r.errs);
  // the page stores "0" itself at start; a link to the 3D view must not turn that into "1"
  check("full link: does not overwrite the saved 3D choice", v.savedIso === "0", v.savedIso);

  r = await open("?sample=eks"); v = look(r);
  check("sample only: the EKS sample, in the saved/default view", /eks/.test(v.plan) && v.tiles > 0, v);

  r = await open("?sample=webapp&view=text"); v = look(r);
  check("view=text: text view on", v.text, v);

  r = await open("?sample=webapp&view=flat"); v = look(r);
  check("view=flat: flat view on", v.flat && !v.iso, v);

  r = await open("?sample=webapp&select=aws_nothing.here"); v = look(r);
  check("an address the plan lacks: plan opens, nothing selected", /full-stack/.test(v.plan) && v.selected === 0 && r.errs.length === 0, v);

  r = await open("?sample=nope&view=3d"); v = look(r);
  check("unknown sample: the empty page, nothing loaded", /no plan loaded/.test(v.plan) && v.tiles === 0 && r.errs.length === 0, v);

  r = await open("?sample=webapp&view=%00&changes=maybe&select=%E0%A4%A"); v = look(r);
  check("junk values: the sample opens in its default view", /full-stack/.test(v.plan) && !v.changes && r.errs.length === 0, v);

  r = await open("?sample=webapp&view=3d&changes=0"); v = look(r);
  check("changes=0 is accepted", /full-stack/.test(v.plan) && !v.changes, v);

  r = await open("?sample=eks&view=3d&changes=1", REPORT); v = look(r);
  check("a report with its own plan ignores `sample`", /MY REPORT/.test(v.plan) && !/eks/.test(v.plan), v.plan);
  check("a report still honours view", v.iso, v);

  const bad = results.filter(c => !c.ok);
  results.forEach(c => console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.what}${c.ok ? "" : "\n       saw: " + JSON.stringify(c.saw)}`));
  console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
})();
