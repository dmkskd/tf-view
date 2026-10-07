// check-csp.js — checks the built page's Content-Security-Policy.
//
// WHAT IT CHECKS
//   - The policy has exactly the directives and source lists in EXPECTED. Any
//     other directive fails, because some (script-src-elem, for example)
//     override script-src.
//   - The page has one executable <script>, its hash is the one script-src
//     lists, and every other <script> is a JSON data block.
//   - The markup has no inline event handlers, javascript: URLs or <link>
//     elements, and every url() in the page's CSS is a data: URI. (Other
//     elements that load by URL, such as <img> or <iframe>, are not checked
//     here; the policy's default-src 'none' and img-src data: block them.)
//   Before checking the page, the script checks itself against modified
//   copies of the page that each violate one rule, and fails unless it
//   rejects all of them.
//
// HOW TO USE IT
//   node tools/check-csp.js [path/to/index.html]     (default: dist/index.html)
//   To change the policy, change it in scripts/build-single-html.js and in
//   EXPECTED below, in the same commit.

const fs = require("fs");
const crypto = require("crypto");

/* Directive -> exact source list. "<hash>" stands for the page script's hash. */
const EXPECTED = {
  "default-src": ["'none'"],
  "script-src": ["<hash>"],
  "style-src": ["'unsafe-inline'"],
  "font-src": ["data:"],
  "img-src": ["data:"],
  "connect-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"]
};

/* Returns the list of problems with this page; empty means it passes. */
function problems(h) {
  const out = [];
  const fail = msg => out.push(msg);

  const metas = [...h.matchAll(/<meta\s[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi)];
  if (metas.length !== 1) { fail(`expected exactly one Content-Security-Policy, found ${metas.length}`); return out; }
  const meta = metas[0][0];
  const content = (meta.match(/\scontent="([^"]*)"/i) || [])[1];
  if (content === undefined) { fail("the policy has no content attribute"); return out; }

  const first = Math.min(...["<script", "<style", "<link"].map(t => { const i = h.indexOf(t); return i < 0 ? Infinity : i; }));
  if (h.indexOf(meta) > first) fail("the policy comes after a script, style or link");

  const scripts = [...h.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  const exec = scripts.filter(m => !/^\s+type="application\/json"(\s+id="[\w-]+")?\s*$/i.test(m[1]));
  if (exec.length !== 1) fail(`expected exactly one executable script, found ${exec.length}`);
  if (exec.some(m => /\bsrc\s*=/i.test(m[1]))) fail("a script loads from src");
  const hash = exec.length ? "'sha256-" + crypto.createHash("sha256").update(exec[0][2], "utf8").digest("base64") + "'" : null;

  const seen = new Set();
  for (const d of content.split(";")) {
    const [name, ...sources] = d.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) { fail(`directive ${key} appears twice`); continue; }
    seen.add(key);
    if (!EXPECTED[key]) { fail(`unexpected directive ${key} ${sources.join(" ")}`); continue; }
    const want = EXPECTED[key].map(s => s === "<hash>" ? hash : s);
    if (JSON.stringify(sources) !== JSON.stringify(want))
      fail(`${key} is "${sources.join(" ")}", expected "${want.join(" ")}"`);
  }
  for (const key of Object.keys(EXPECTED)) if (!seen.has(key)) fail(`directive ${key} is missing`);

  const markup = h.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  /* no <link> elements (stylesheets, preconnects), and every url() in the
     page's CSS is a data: URI */
  const links = markup.match(/<link\b[^>]*>/gi) || [];
  if (links.length) fail("the page links an outside resource: " + links[0]);
  const styles = (h.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join("\n");
  const urls = styles.match(/url\(\s*(?!["']?data:)[^)]*\)/gi) || [];
  if (urls.length) fail("the CSS loads by URL: " + urls[0].slice(0, 80));
  const handlers = markup.match(/<[^>]+\son[a-z]+\s*=/gi) || [];
  if (handlers.length) fail("inline event handler in the markup: " + handlers.slice(0, 3).join(" | "));
  if (/javascript:/i.test(markup)) fail("javascript: url in the markup");
  if (exec.length && /\beval\s*\(|new\s+Function\s*\(/.test(exec[0][2])) fail("the app uses eval");
  return out;
}

const file = process.argv[2] || __dirname + "/../dist/index.html";
const page = fs.readFileSync(file, "utf8");
let failed = 0;
function report(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? "\n       " + detail : ""}`);
  if (!ok) failed++;
}

/* ---- the checker rejects weakened copies of this page ---------------- */
const policyOf = h => (h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || "";
const withPolicy = p => page.replace(policyOf(page), p);
const pol = policyOf(page);
const WEAKENED = {
  "script-src-elem overriding script-src": withPolicy(pol + "; script-src-elem 'unsafe-inline' https:"),
  "script-src-attr allowing handlers":     withPolicy(pol + "; script-src-attr 'unsafe-inline'"),
  "'unsafe-inline' added to script-src":   withPolicy(pol.replace("script-src ", "script-src 'unsafe-inline' ")),
  "'strict-dynamic' added to script-src":  withPolicy(pol.replace("script-src ", "script-src 'strict-dynamic' ")),
  "a second hash in script-src":           withPolicy(pol.replace("script-src ", "script-src 'sha256-AAAA' ")),
  "connect-src opened":                    withPolicy(pol.replace("connect-src 'none'", "connect-src https:")),
  "default-src dropped":                   withPolicy(pol.replace("default-src 'none'; ", "")),
  "duplicate script-src":                  withPolicy(pol + "; script-src 'unsafe-inline'"),
  "frame-src added":                       withPolicy(pol + "; frame-src https:"),
  "a second policy meta":                  page.replace("<head>", '<head>\n<meta http-equiv="Content-Security-Policy" content="script-src *">'),
  "an extra inline script":                page.replace("</body>", "<script>1</script></body>"),
  "a script with src":                     page.replace("</body>", '<script src="https://x.example/a.js"></script></body>'),
  "an inline event handler":               page.replace("</body>", '<img src=x onerror="1"></body>'),
  "an outside stylesheet link":            page.replace("</head>", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X"></head>'),
  "a font loaded by URL":                  page.replace("</style>", '@font-face{font-family:X;src:url(https://x.example/f.woff2)}</style>'),
  "font-src opened":                       withPolicy(pol.replace("font-src data:", "font-src data: https:")),
  "the page script changed":               page.replace(/(<script>)/, "$1/* changed */")
};
for (const [name, html] of Object.entries(WEAKENED)) {
  report(`rejects: ${name}`, html !== page && problems(html).length > 0,
         html === page ? "mutation did not apply" : "the checker accepted it");
}

/* ---- the page itself -------------------------------------------------- */
const found = problems(page);
report("the built page has exactly the expected policy", found.length === 0, found.join("\n       "));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
