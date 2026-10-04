#!/usr/bin/env node
// scripts/build-single-html.js — Assembles self-contained single-file HTML asset
// Inspired by dmkskd/tracehouse and dmkskd/k8s-compass

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ts = require("typescript");

console.log("📦 Building single self-contained HTML asset for tfview...");

const ROOT_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT_DIR, "src");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const DIST_FILE = path.join(DIST_DIR, "index.html");

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// 1. Read CSS files in cascade order
const cssOrder = [
  "reset.css",
  "tokens.css",
  "topbar.css",
  "layout.css",
  "canvas.css",
  "iso.css",
  "tiles.css",
  "detail.css"
];

let cssContent = "";
for (const f of cssOrder) {
  const filePath = path.join(SRC_DIR, "css", f);
  if (fs.existsSync(filePath)) {
    cssContent += fs.readFileSync(filePath, "utf8").trim() + "\n";
  }
}

// 2. Read and minify embedded JSON data
const kindsData = fs.readFileSync(path.join(SRC_DIR, "data", "collection-kinds.json"), "utf8").trim();
const planData = fs.readFileSync(path.join(SRC_DIR, "data", "sample-plan.json"), "utf8").trim();
const planDataFullstack = fs.readFileSync(path.join(SRC_DIR, "data", "sample-plan-fullstack.json"), "utf8").trim();
const planDataEks = fs.readFileSync(path.join(SRC_DIR, "data", "sample-plan-eks.json"), "utf8").trim();

const minKinds = JSON.stringify(JSON.parse(kindsData));
const minPlan = JSON.stringify(JSON.parse(planData));
const minPlanFullstack = JSON.stringify(JSON.parse(planDataFullstack));
const minPlanEks = JSON.stringify(JSON.parse(planDataEks));

// 3. Module Dependency Graph Resolution starting at main.ts
function crawlDependencyGraph(entryFile) {
  const visited = new Set();
  const graph = [];

  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const code = fs.readFileSync(file, "utf8");
    const dir = path.dirname(file);
    const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(code)) !== null) {
      const rawTarget = match[1];
      let target = path.resolve(dir, rawTarget);
      if (!fs.existsSync(target)) {
        if (target.endsWith(".js") && fs.existsSync(target.slice(0, -3) + ".ts")) {
          target = target.slice(0, -3) + ".ts";
        } else if (fs.existsSync(target + ".ts")) {
          target = target + ".ts";
        } else if (fs.existsSync(target + ".js")) {
          target = target + ".js";
        }
      }
      if (fs.existsSync(target)) {
        visit(target);
      } else {
        throw new Error(`Import target not found: ${match[1]} in ${file}`);
      }
    }
    graph.push(file);
  }

  visit(path.resolve(entryFile));
  return graph;
}

const entryPoint = path.join(SRC_DIR, "ts", "main.ts");
const resolvedModules = crawlDependencyGraph(entryPoint);
console.log(`  ✓ Resolved ${resolvedModules.length} modules from dependency graph starting at main.ts`);

// Helper to read and strip module syntax and TypeScript types
function transformModule(fullPath) {
  let raw = fs.readFileSync(fullPath, "utf8");
  let code = ts.transpileModule(raw, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: false
    }
  }).outputText;
  code = code.replace(/^\/\/.*$/gm, ""); // remove line comments at start
  code = code.replace(/^import\s+[^;]+;\s*$/gm, "");
  code = code.replace(/^import\s*\{[\s\S]*?\}\s*from\s*[^;]+;\s*$/gm, "");
  code = code.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, "");
  code = code.replace(/^export\s+default\s+[^;]+;?\s*$/gm, "");
  code = code.replace(/^export\s+(function|var|const|let|class)\s+/gm, "$1 ");
  return code.trim();
}

function getModuleByRelative(relPath) {
  const tsPath = relPath.replace(/\.js$/, ".ts");
  let target = path.join(SRC_DIR, "ts", tsPath);
  if (!fs.existsSync(target)) {
    target = path.join(SRC_DIR, "ts", relPath);
  }
  if (!resolvedModules.includes(target)) {
    throw new Error(`Module ${relPath} (${target}) is not reachable from main.ts dependency graph!`);
  }
  return transformModule(target);
}

// 4. Assemble JavaScript bundle with clean landmark comments for test harnesses
// Section 1: Registry, Provider Catalogs, CLI, HCL
// Note: test harnesses slice on:
//   "var AWS_REG = {" to "var ACTION_COLOR"
//   "function hclLit" to "/* ---- AWS CLI"
//   "function cliQuote(s)" to "var ACTION_COLOR"
const section1 = `
  /* ============================================================
     1. REGISTRY — provider catalogs, HCL builders & CLI recipes
     ============================================================ */

  ${getModuleByRelative("providers/aws/catalog.js")}

  ${getModuleByRelative("core/hcl.js")}

  ${getModuleByRelative("providers/aws/cli.js")}

  ${getModuleByRelative("core/links.js")}

  ${getModuleByRelative("providers/aws/console.js")}

  ${getModuleByRelative("providers/aws/index.js")}

  ${getModuleByRelative("providers/gcp/index.js")}

  ${getModuleByRelative("providers/registry.js")}

  var ACTION_COLOR = {
    create:"var(--create)", update:"var(--update)", replace:"var(--replace)",
    delete:"var(--destroy)", "no-op":"var(--noop)", read:"var(--update)"
  };
`;

// Section 2: Parser + Validation
// Note: test harnesses slice on:
//   "var ACTION_COLOR" to "function actionOf"
//   "function actionOf" to "/* ============================================================\\n     3. LAYOUT"
const section2 = `
  /* ============================================================
     2. PARSER + VALIDATION
     ============================================================ */

  ${getModuleByRelative("core/parser.js")}

  ${getModuleByRelative("core/references.js")}

  ${getModuleByRelative("core/snapshot.js")}
`;

// Section 3: Layout — nested boxes, measured bottom-up
// Note: test harnesses slice on:
//   "/* ============================================================\\n     3. LAYOUT" to "/* ============================================================\\n     4. RENDER"
const section3 = `
  /* ============================================================
     3. LAYOUT — nested boxes, measured bottom-up
     ============================================================ */

  ${getModuleByRelative("core/tree.js")}

  ${getModuleByRelative("providers/aws/placement.js")}

  ${getModuleByRelative("providers/gcp/placement.js")}

  ${getModuleByRelative("core/layout.js")}
`;

// Section 4: Render
// Note: test harnesses slice on:
//   "var SCHEMA = null;" to "/* ------------------------------------------------------------------\\n     Rule preview."
//   "var PORT_NAME" to "/* --- collapsible sections"
//   "function changedKeys" to "function titleFor"
const section4 = `
  /* ============================================================
     4. RENDER
     ============================================================ */

  ${getModuleByRelative("core/util.js")}

  ${getModuleByRelative("core/state.js")}

  ${getModuleByRelative("ui/llm-review.js")}

  ${getModuleByRelative("ui/diagram.js")}

  ${getModuleByRelative("ui/iso.js")}

  /* ------------------------------------------------------------------
     Provider schema (optional).
     ------------------------------------------------------------------ */

  ${getModuleByRelative("core/schema.js")}

  /* ------------------------------------------------------------------
     Rule preview. Security groups and network ACLs are the two things you
     most often want to read without opening anything, so hovering one
     shows its rules as direction, port, protocol and peer.
     ------------------------------------------------------------------ */

  ${getModuleByRelative("providers/aws/rules.js")}

  ${getModuleByRelative("core/diff.js")}

  /* --- collapsible sections, remembered per section across selections --- */

  ${getModuleByRelative("ui/detail.js")}

  ${getModuleByRelative("ui/rule-popover.js")}

  ${getModuleByRelative("ui/contextmenu.js")}

  ${getModuleByRelative("ui/textview.js")}

  ${getModuleByRelative("ui/sidebar.js")}
`;

// Section 5: Loading
const section5 = `
  /* ============================================================
     5. LOADING
     ============================================================ */

  ${getModuleByRelative("app.js")}

  ${getModuleByRelative("main.js")}
`;

const jsBundle = `(function(){
  "use strict";

  /* ==================================================================
     tf plan view

     Reads \`terraform show -json\` output and draws it as an AWS
     architecture diagram. No dependencies, no build step.

     Pipeline:
       parsePlan()  plan JSON  -> model {resources, diagnostics, summary}
       buildTree()  model      -> nested boxes with absolute positions
       render()     tree       -> DOM, then sidebar and detail pane
     ================================================================== */
${section1}
${section2}
${section3}
${section4}
${section5}
})();
`;

// 4b. Every module lands in one scope, so a name declared at the top level of
// two modules silently shadows the other. Stop the build rather than ship that.
// Top-level declarations are the ones at column 0 in a module file.
const declaredIn = new Map();
for (const file of resolvedModules) {
  const code = transformModule(file);
  for (const m of code.matchAll(/^(?:export\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (!declaredIn.has(name)) declaredIn.set(name, []);
    declaredIn.get(name).push(path.relative(SRC_DIR, file));
  }
}
const clashes = [...declaredIn].filter(([, files]) => files.length > 1);
if (clashes.length) {
  console.error("\n❌ the same name is declared at the top level of more than one module:");
  for (const [name, files] of clashes) console.error(`   ${name}  —  ${files.join(", ")}`);
  console.error("   The build flattens every module into one scope. Rename one of each pair.\n");
  process.exit(1);
}
console.log(`  ✓ No name declared in two modules (${declaredIn.size} top-level names)`);

// 5. Read dev-time HTML template head & body
const devHtml = fs.readFileSync(path.join(SRC_DIR, "index.html"), "utf8");
const bodyMatch = devHtml.match(/<body>([\s\S]*?)<script/);
const bodyMarkup = bodyMatch[1].trim();

// 6. Construct single-file HTML
const singleHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Render any Terraform plan as an interactive cloud architecture diagram (currently supporting AWS).">
<title>tf view</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
${cssContent.trim()}
</style>
</head>
<body>
${bodyMarkup}

<script>
${jsBundle.trim()}
</script>
<!-- set/list/map per attribute for the AWS provider, from
     \`terraform providers schema -json\` by tools/make-kinds.js. Says whether each
     collection attribute is a set (s), list (l) or map (m), which is all a diff
     needs. 109KB here against 13MB for the full schema. -->
<script type="application/json" id="collection-kinds">${minKinds}</script>
<!-- dedicated container for CLI-injected plans so samples are never overwritten -->
<script type="application/json" id="injected-plan"></script>
<!-- bundled sample plans for offline testing and demos -->
<script type="application/json" id="embedded-plan">${minPlan}</script>
<script type="application/json" id="embedded-plan-fullstack">${minPlanFullstack}</script>
<script type="application/json" id="embedded-plan-eks">${minPlanEks}</script>
</body>
</html>
`;

// Write to dist/index.html
fs.writeFileSync(DIST_FILE, singleHtml);

// 7. Landmark Verification Check
const requiredLandmarks = [
  "var AWS_REG = {",
  "var ACTION_COLOR",
  "function actionOf",
  "/* ============================================================\n     3. LAYOUT",
  "/* ============================================================\n     4. RENDER",
  "var SCHEMA = null;",
  "/* ------------------------------------------------------------------\n     Rule preview.",
  "var PORT_NAME",
  "/* --- collapsible sections",
  "function changedKeys",
  "function titleFor"
];

for (const lm of requiredLandmarks) {
  if (!singleHtml.includes(lm)) {
    console.error(`❌ Build Error: Missing critical landmark: "${lm.trim()}"`);
    process.exit(1);
  }
}
console.log("  ✓ All architectural landmarks verified in output HTML");

// 8. Bundle Statistics & ASCII Visualizer
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

const finalSize = Buffer.byteLength(singleHtml, "utf8");
const jsSize = Buffer.byteLength(jsBundle, "utf8");
const cssSize = Buffer.byteLength(cssContent, "utf8");
const dataSize = Buffer.byteLength(minKinds + minPlan, "utf8");
const htmlMarkupSize = finalSize - jsSize - cssSize - dataSize;

const gzSize = zlib.gzipSync(Buffer.from(singleHtml, "utf8")).length;

console.log("\n  ╭─────────────────────────────────────────────────────────────╮");
console.log("  │               TF PLAN VIEW BUNDLE REPORT                    │");
console.log("  ╰─────────────────────────────────────────────────────────────╯");

console.log("\n  Composition breakdown:");
const items = [
  { name: "JavaScript App", size: jsSize },
  { name: "Embedded Schema & Plan", size: dataSize },
  { name: "CSS Stylesheets", size: cssSize },
  { name: "HTML Shell & SVG Icons", size: htmlMarkupSize }
];

items.forEach(it => {
  const pct = ((it.size / finalSize) * 100).toFixed(1);
  const barLen = Math.round((it.size / finalSize) * 30);
  const bar = "█".repeat(barLen) + "░".repeat(Math.max(0, 30 - barLen));
  console.log(`    ${it.name.padEnd(25)} ${bar}  ${pct.padStart(5)}% (${formatBytes(it.size)})`);
});

console.log(`\n  Total Uncompressed:  ${formatBytes(finalSize)}`);
console.log(`  Gzipped / Over wire: ${formatBytes(gzSize)} (${((1 - gzSize / finalSize) * 100).toFixed(1)}% compression)`);
console.log(`\n  ✓ Self-contained: Zero external JS/runtime dependencies`);
console.log(`  ✓ Output: ${path.relative(ROOT_DIR, DIST_FILE)}\n`);
