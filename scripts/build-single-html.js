#!/usr/bin/env node
// scripts/build-single-html.js — Assembles self-contained single-file HTML asset
// Inspired by dmkskd/tracehouse and dmkskd/k8s-compass

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

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
  "fonts.css",
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

// Each url("../fonts/x.woff2") in the CSS is replaced by a data: URI holding
// the font file, so the page requests no fonts from another origin (the CSP's
// font-src allows data: only).
let fontBytes = 0;
cssContent = cssContent.replace(/url\("\.\.\/fonts\/([a-z0-9-]+\.woff2)"\)/g, (m, name) => {
  const buf = fs.readFileSync(path.join(SRC_DIR, "fonts", name));
  fontBytes += buf.length;
  return `url("data:font/woff2;base64,${buf.toString("base64")}")`;
});
if (/url\((?!"data:)/.test(cssContent)) {
  console.error("❌ the CSS loads something by URL; only data: URIs may be bundled");
  process.exit(1);
}
console.log(`  ✓ Inlined fonts (${(fontBytes / 1024).toFixed(0)} KB)`);

// 2. Read the embedded JSON data and remove its whitespace
const kindsData = fs.readFileSync(path.join(SRC_DIR, "data", "collection-kinds.json"), "utf8").trim();
const planData = fs.readFileSync(path.join(SRC_DIR, "data", "sample-plan.json"), "utf8").trim();
const planDataFullstack = fs.readFileSync(path.join(SRC_DIR, "data", "sample-plan-fullstack.json"), "utf8").trim();
const planDataEks = fs.readFileSync(path.join(SRC_DIR, "data", "sample-plan-eks.json"), "utf8").trim();

const minKinds = JSON.stringify(JSON.parse(kindsData));
const minPlan = JSON.stringify(JSON.parse(planData));
const minPlanFullstack = JSON.stringify(JSON.parse(planDataFullstack));
const minPlanEks = JSON.stringify(JSON.parse(planDataEks));

// 3. Bundle the TypeScript with esbuild, starting from main.ts. esbuild places
// all modules in one function scope and renames names that clash. A module
// uses another module's names only through imports: tsc (run before this
// script) rejects a name used without an import, and the CSP has no
// 'unsafe-eval', so eval and Function cannot reach other names at runtime.
const esbuild = require("esbuild");
const bundle = esbuild.buildSync({
  entryPoints: [path.join(SRC_DIR, "ts", "main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  charset: "utf8",
  legalComments: "none",
  banner: { js: '"use strict";' },
  write: false,
  metafile: true,
  logLevel: "warning"
});
const jsBundle = bundle.outputFiles[0].text;
const moduleCount = Object.keys(bundle.metafile.inputs).length;
console.log(`  ✓ Bundled ${moduleCount} modules from main.ts with esbuild`);
if (jsBundle.includes("</script")) {
  console.error("❌ the bundle contains </script and would end its own tag early");
  process.exit(1);
}

// 4. Read the body markup from the dev-time HTML page
const devHtml = fs.readFileSync(path.join(SRC_DIR, "index.html"), "utf8");
const bodyMatch = devHtml.match(/<body>([\s\S]*?)<script/);
const bodyMarkup = bodyMatch[1].trim();

// 5. Assemble the single-file HTML.
// Content-Security-Policy: script-src lists only the sha256 hash of the one
// inline script; connect-src, base-uri, form-action and default-src are
// 'none'; fonts may come only from data: URIs and images from data: URIs.
// style-src allows inline styles, because the renderer positions boxes with
// style attributes. Report generators (the tfview CLI, the Atlantis demo)
// fill only the JSON data blocks injected-plan and tfview-config and add no
// script, so their reports keep this policy.
const scriptText = "\n" + jsBundle.trim() + "\n";
const scriptHash = crypto.createHash("sha256").update(scriptText, "utf8").digest("base64");
const csp = [
  "default-src 'none'",
  `script-src 'sha256-${scriptHash}'`,
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

const singleHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Render any Terraform plan as an interactive cloud architecture diagram (currently supporting AWS).">
<title>tf view</title>
<style>
${cssContent.trim()}
</style>
</head>
<body>
${bodyMarkup}

<script>${scriptText}</script>
<!-- set/list/map per attribute for the AWS provider, from
     \`terraform providers schema -json\` by tools/make-kinds.js. Says whether each
     collection attribute is a set (s), list (l) or map (m), which is all a diff
     needs. 109KB here against 13MB for the full schema. -->
<script type="application/json" id="collection-kinds">${minKinds}</script>
<!-- report settings an injector may fill: {"autoload","viewerOnly","showChanges","label"} -->
<script type="application/json" id="tfview-config">{}</script>
<!-- dedicated container for CLI-injected plans so samples are never overwritten -->
<script type="application/json" id="injected-plan"></script>
<!-- bundled sample plans for offline testing and demos -->
<script type="application/json" id="embedded-plan">${minPlan}</script>
<script type="application/json" id="embedded-plan-fullstack">${minPlanFullstack}</script>
<script type="application/json" id="embedded-plan-eks">${minPlanEks}</script>
</body>
</html>
`;

// 6. Write dist/index.html
fs.writeFileSync(DIST_FILE, singleHtml);

// 7. Print the bundle size report
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
console.log(`\n  ✓ Self-contained: nothing loads from outside the page (fonts included)`);
console.log(`  ✓ Output: ${path.relative(ROOT_DIR, DIST_FILE)}\n`);
