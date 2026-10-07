// check-boot.js — does the app script actually run?
//
// WHAT IT CHECKS
//   The other harnesses load the core modules on their own (tools/lib/app.js)
//   and call them. None of them run the whole page script, so an exception thrown while the
//   app is setting itself up — a lookup for an element that no longer exists,
//   a reference to a renamed variable — goes unnoticed: the page renders its
//   static markup and every control silently does nothing.
//
//   This shims just enough DOM for the script to execute, runs it, and reports
//   anything it throws, plus which elements it asked for and which listeners
//   it managed to register.
//
// HOW TO USE IT
//   node tools/check-boot.js          exits non-zero if the script throws
const fs = require("fs");
const defaultPath = fs.existsSync(__dirname + "/../dist/index.html")
  ? __dirname + "/../dist/index.html"
  : __dirname + "/../index.html";
const path = process.argv[2] || defaultPath;
const h = fs.readFileSync(path, "utf8");
const js = h.match(/<script>([\s\S]*?)<\/script>\s*(?:<!--[\s\S]*?-->\s*)*<script type="application\/json"/)
        || h.match(/<script>([\s\S]*?)<\/script>/g);

const src = (h.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map(s => s.replace(/^<script>/, "").replace(/<\/script>$/, ""))
  .sort((a, b) => b.length - a.length)[0];

const ids = new Set([...h.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
const asked = new Set(), missing = new Set(), listeners = [];

function el(id) {
  const node = {
    id,
    hidden: false, disabled: false, textContent: "", innerHTML: "", title: "",
    style: new Proxy({}, { get: (t, k) => (k === "setProperty" ? () => {} : t[k] || ""),
                           set: (t, k, v) => (t[k] = v, true) }),
    dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener: (ev) => listeners.push(`${id}:${ev}`),
    removeEventListener(){}, appendChild(){}, removeChild(){}, remove(){},
    setAttribute(){}, getAttribute: () => null, removeAttribute(){},
    querySelector: () => null,
    querySelectorAll: () => [], closest: () => null, focus(){}, select(){},
    getBoundingClientRect: () => ({width:0,height:0,top:0,left:0}),
    offsetWidth: 0, offsetHeight: 0, clientWidth: 900, clientHeight: 700,
    scrollLeft: 0, scrollTop: 0, scrollWidth: 900, scrollHeight: 700,
    getTotalLength: () => 100, getPointAtLength: () => ({x:0,y:0}),
    files: [], value: "", checked: false, open: false,
  };
  if (id === "embedded-plan" || id === "collection-kinds") {
    const m = h.match(new RegExp(`id="${id}">([\\s\\S]*?)</script>`));
    node.textContent = m ? m[1] : "";
  }
  return node;
}

global.window = {
  matchMedia: () => ({ matches: false, addEventListener(){} }),
  addEventListener(){}, innerWidth: 1400, innerHeight: 900,
  requestAnimationFrame: (f) => { try { f(0); } catch(e){} },
};
global.requestAnimationFrame = global.window.requestAnimationFrame;
global.navigator = { clipboard: { writeText: () => Promise.resolve() } };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.setTimeout = (f) => 0;
global.document = {
  readyState: "complete",
  documentElement: el("html"),
  body: el("body"),
  addEventListener(){},
  createElement: (t) => el("<" + t + ">"),
  createElementNS: (ns, t) => el("<" + t + ">"),
  getElementById(id) {
    asked.add(id);
    if (!ids.has(id)) { missing.add(id); return null; }
    return el(id);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  execCommand(){},
};

let threw = null;
try { new Function(src)(); } catch (e) { threw = e; }

console.log(`elements requested: ${asked.size}`);
console.log(`listeners registered: ${listeners.length}`);
if (missing.size) console.log(`missing from markup: ${[...missing].join(", ")}`);
if (threw) {
  console.error("\nthe script threw while starting up:\n");
  console.error(threw && threw.stack ? threw.stack.split("\n").slice(0, 6).join("\n") : threw);
  process.exit(1);
}
console.log("boot: clean");
