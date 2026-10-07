// check-providers.js — checks what code under src/ts/providers/<name>/ uses,
// and that code outside those folders names no provider.
//
// WHAT IT CHECKS
//   - Provider files import only the provider SDK (src/ts/sdk/index.ts) and
//     files in their own folder.
//   - Provider files do not reference or declare the globals in
//     BANNED_GLOBALS (the DOM, network, storage, timers, eval, Function,
//     Reflect, Proxy, require, ...), do not use the properties in
//     BANNED_PROPS (HTML sinks, prototype access), and contain no
//     @ts-ignore, @ts-nocheck, @ts-expect-error, `declare` or `with`.
//   - Core, UI, SDK and types code contains no string or regular expression
//     that holds a registered provider's type prefix or equals its id or a
//     local name (comments are not checked).
//   - No CSS custom property in src/ is named after a registered provider.
//   The provider checks run on the TypeScript syntax tree, so text in
//   comments and strings is not matched and formatting does not affect the
//   result. Before checking the real files, the script checks itself against
//   snippets that each violate one rule, and fails unless it rejects all.
//
// LIMITS
//   A static check: it does not see property names built at runtime from
//   non-literal strings. At runtime the page's CSP blocks eval and Function,
//   network connections, and loads from other origins.
//
// HOW TO USE IT
//   node tools/check-providers.js

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const PROVIDERS = path.join(__dirname, "..", "src", "ts", "providers");
const SDK = "../../sdk/index.js";

/* Global names that provider files may not reference or declare. */
const BANNED_GLOBALS = new Set([
  "window", "document", "globalThis", "self", "top", "parent", "frames", "opener",
  "location", "history", "navigator", "localStorage", "sessionStorage", "indexedDB", "caches",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker",
  "importScripts", "postMessage", "BroadcastChannel", "MessageChannel",
  "eval", "Function", "setTimeout", "setInterval", "setImmediate", "queueMicrotask",
  "requestAnimationFrame", "requestIdleCallback", "Image", "Audio", "alert", "confirm", "prompt",
  "require", "module", "exports", "process", "Reflect", "Proxy", "WebAssembly"
]);
/* Property names that provider files may not use: HTML sinks, and the names
   that reach an object's prototype or the Function constructor. Data field
   names such as href or action are allowed, because provider code has no
   element to set them on. */
const BANNED_PROPS = new Set([
  "innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc", "cookie",
  "constructor", "__proto__", "prototype", "__defineGetter__", "__defineSetter__"
]);
const BANNED_DIRECTIVES = /@ts-(ignore|nocheck|expect-error)/;

/* Returns the problems in one provider source file. */
function problems(rel, text) {
  const out = [];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const at = n => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  if (BANNED_DIRECTIVES.test(text)) out.push(`${rel}: type-check suppression (@ts-ignore/-nocheck/-expect-error)`);

  function checkSpecifier(node, spec) {
    if (spec === SDK) return;
    if (/^\.\/[\w.-]+\.js$/.test(spec)) return;          /* a file in the same folder */
    out.push(`${at(node)}: imports "${spec}" (only ${SDK} and ./file.js in the same folder)`);
  }

  (function visit(n) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      checkSpecifier(n, n.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(n)) {
      out.push(`${at(n)}: import = require(...)`);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push(`${at(n)}: dynamic import()`);
    } else if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) ||
                         (ts.isPropertyAssignment(p) && p.name === n) ||
                         (ts.isPropertySignature(p) && p.name === n) ||
                         (ts.isMethodDeclaration(p) && p.name === n) ||
                         (ts.isPropertyDeclaration(p) && p.name === n);
      if (isPropName) {
        if (BANNED_PROPS.has(n.text)) out.push(`${at(n)}: property ${n.text}`);
      } else if (BANNED_GLOBALS.has(n.text)) {
        /* every use is flagged, including declaring a local of that name: a
           local "window" would otherwise excuse the real one elsewhere */
        out.push(`${at(n)}: ${n.text}`);
      }
    } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      const k = n.argumentExpression.text;
      if (BANNED_PROPS.has(k) || BANNED_GLOBALS.has(k)) out.push(`${at(n)}: ["${k}"]`);
    } else if (n.kind === ts.SyntaxKind.DeclareKeyword) {
      out.push(`${at(n)}: declare`);
    } else if (n.kind === ts.SyntaxKind.WithStatement) {
      out.push(`${at(n)}: with statement`);
    }
    ts.forEachChild(n, visit);
  })(sf);
  return out;
}

let failed = 0;
function report(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? "\n       " + detail : ""}`);
  if (!ok) failed++;
}

/* ---- the checker rejects each kind of violation ---------------------- */
const BAD = {
  "importing core directly":        'import { state } from "../../core/state.js";',
  "importing the UI":               'import { render } from "../../ui/diagram.js";',
  "importing another provider":     'import { awsCommands } from "../aws/cli.js";',
  "importing a package":            'import x from "lodash";',
  "re-exporting from core":         'export { escapeHtml } from "../../core/util.js";',
  "dynamic import":                 'const m = import("../../core/state.js");',
  "require":                        'const m = require("fs");',
  "document":                       'const t = document.title;',
  "window via alias":               'const w = globalThis; w.alert(1);',
  "fetch":                          'fetch("https://x.example");',
  "localStorage":                   'localStorage.setItem("k", "v");',
  "eval":                           'eval("1");',
  "Function constructor":           'new Function("return 1")();',
  "constructor climb":              'const F = ({}).constructor.constructor;',
  "constructor by string":          'const F = ({})["constructor"];',
  "innerHTML":                      'el.innerHTML = "x";',
  "__proto__ write":                'const o: any = {}; o.__proto__.polluted = 1;',
  "outerHTML":                      'el.outerHTML = "<b>x</b>";',
  "timer":                          'setTimeout(() => {}, 1);',
  "ts-ignore":                      '// @ts-ignore\nconst x: number = "s";',
  "declare":                        'declare const secret: string;',
  "Reflect":                        'Reflect.get({}, "a");',
  "shadowing a global":             'function a(fetch: any) { return fetch; }'
};
for (const [name, code] of Object.entries(BAD)) {
  report(`rejects: ${name}`, problems("providers/test/x.ts", code).length > 0, "accepted");
}
const GOOD = [
  'import { mkGroup, PlanResource } from "../../sdk/index.js";',
  'import { helper } from "./helper.js";',
  'const attrs = { href: 1, action: "deny" }; const v = attrs.cidr_block; function f(document_id: string) { return document_id; }',
  'function place(parentGroup: string) { const where = parentGroup; return where; }'
];
for (const code of GOOD) {
  const p = problems("providers/test/x.ts", code);
  report(`accepts: ${code.slice(0, 60)}`, p.length === 0, p.join("; "));
}

/* ---- the real providers ---------------------------------------------- */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const files = fs.readdirSync(PROVIDERS, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .flatMap(e => walk(path.join(PROVIDERS, e.name)));
for (const f of files) {
  const rel = path.relative(path.join(PROVIDERS, ".."), f).split(path.sep).join("/");
  if (!f.endsWith(".ts")) { report(`${rel} is TypeScript`, false, "only .ts files may live in a provider folder"); continue; }
  const p = problems(rel, fs.readFileSync(f, "utf8"));
  report(rel, p.length === 0, p.join("\n       "));
}

/* ---- core and UI name no provider --------------------------------------
   Core, UI, SDK and types must not branch on a provider: no string or regex
   in their code (comments are fine) may contain a registered provider's type
   prefix ("aws_") or be its id or provider type ("aws", "google"). */
const { load } = require("./lib/app.js");
const registered = load().fn("getAllProviders")();
const prefixes = registered.map(p => p.typePrefix).filter(Boolean);
const names = new Set(registered.flatMap(p => [p.id].concat(p.localNames || [])));
function namesProvider(text) {
  return prefixes.some(x => text.includes(x)) || names.has(text.trim().toLowerCase());
}
function coreProblems(rel, text) {
  const out = [];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  (function visit(n) {
    let lit = null;
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) lit = n.text;
    else if (ts.isRegularExpressionLiteral(n)) lit = n.text;
    if (lit !== null && namesProvider(lit) && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent))
      out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${JSON.stringify(lit.slice(0, 50))}`);
    ts.forEachChild(n, visit);
  })(sf);
  return out;
}
report(`core check sees the registered providers (${[...names].join(", ")})`, prefixes.length > 0 && names.size > 0);
report("core check rejects a provider prefix and a provider name",
  coreProblems("t.ts", 'if (r.type === "aws_vpc") x(); const re = /^google_/; const p = "aws";').length === 3);
const SRC_TS = path.join(PROVIDERS, "..");
const coreFiles = ["core", "ui", "sdk", "types"].flatMap(d => walk(path.join(SRC_TS, d)))
  .concat(["app.ts", "main.ts"].map(f => path.join(SRC_TS, f)))
  .filter(f => f.endsWith(".ts"));
const coreFound = coreFiles.flatMap(f =>
  coreProblems(path.relative(SRC_TS, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")));
report(`core, UI, SDK and types name no provider (${coreFiles.length} files)`, coreFiles.length > 20 && coreFound.length === 0, coreFound.join("\n       "));

/* Styling is shared too: no CSS custom property is named after a provider
   (--aws-net), anywhere, providers included. Category colours are --cat-*. */
const styleFiles = walk(path.join(SRC_TS, "..", "css")).concat(walk(SRC_TS)).concat([path.join(SRC_TS, "..", "index.html")])
  .filter(f => /\.(css|ts|html)$/.test(f));
const tokenRe = new RegExp("--(" + [...names].map(n => n.replace(/[^a-z0-9-]/g, "")).join("|") + ")-[a-z]", "g");
const tokenFound = styleFiles.flatMap(f => {
  const m = fs.readFileSync(f, "utf8").match(tokenRe) || [];
  return m.length ? [path.relative(path.join(SRC_TS, ".."), f) + ": " + [...new Set(m)].join(", ")] : [];
});
report("no CSS custom property is named after a provider", tokenFound.length === 0, tokenFound.join("\n       "));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
