// lib/app.js — loads the app's core modules into Node for the test scripts.
//
// WHAT IT DOES
//   Bundles the modules listed in CORE (and the registered providers) from
//   src/ts with esbuild, the bundler the build uses, and loads the result as
//   one CommonJS module; each export is available by name through fn().
//   The sample plans and the collection-kinds table are read from the built
//   page, so the tests use the data included in the build.
//
// USED BY
//   tools/test.js, check-pure.js, check-parse.js, check-layout.js,
//   dump-model.js, audit-links.js.

const fs = require("fs");
const path = require("path");
const Module = require("module");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "src", "ts");

/* The modules a harness may call into. UI modules are left out: they touch
   the DOM as soon as they load. */
const CORE = ["parser", "references", "layout", "tree", "diff", "schema", "snapshot",
              "hcl", "shell", "util", "registry", "rules", "links", "placement", "redact", "readonly", "hooks", "icons"];

let cached = null;
function bundle() {
  if (cached) return cached;
  const entry = ['import "./providers/index.ts";']
    .concat(CORE.map(m => `export * from "./core/${m}.ts";`))
    .concat(['export { referencedValues, singleReferencedValue } from "./sdk/refs.ts";'])
    .join("\n");
  const out = esbuild.buildSync({
    stdin: { contents: entry, resolveDir: SRC, sourcefile: "harness-entry.ts", loader: "ts" },
    bundle: true, format: "cjs", platform: "node", target: "node18",
    write: false, logLevel: "error"
  });
  const file = path.join(SRC, "harness-bundle.js");
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(SRC);
  m._compile(out.outputFiles[0].text, file);
  cached = m.exports;
  return cached;
}

function load(htmlPath) {
  const defaultPath = path.join(ROOT, "dist", "index.html");
  const h = fs.readFileSync(htmlPath || defaultPath, "utf8");
  const block = id => {
    const m = h.match(new RegExp(`id="${id}">([\\s\\S]*?)</script>`));
    if (!m) throw new Error("no data block: " + id);
    return m[1];
  };

  /* core/schema.ts reads the collection-kinds table from the page */
  global.document = { getElementById: id => (id === "collection-kinds" ? { textContent: block(id) } : null) };

  const exp = bundle();
  return {
    html: h,
    block,
    samplePlan: () => JSON.parse(block("embedded-plan")),
    exports: exp,
    fn: name => {
      const f = exp[name];
      if (typeof f !== "function") throw new Error("not loaded: " + name);
      return f;
    }
  };
}

module.exports = { load };
