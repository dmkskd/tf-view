#!/usr/bin/env node
// make-kinds.js — build-time only. Produces the collection-kind table that is
// bundled inside index.html; the app never runs this.
//
// WHY IT EXISTS
//   To diff a collection correctly you must know whether it is a set (order
//   is meaningless, match entries by content), a list (order matters, match by
//   position) or a map (match by key). Only the provider schema knows this.
//   The full AWS schema is ~13MB, which is too large to bundle — but the diff
//   needs one letter per attribute, and that is ~109KB for the whole provider.
//
// HOW TO USE IT
//   terraform providers schema -json > schema.json
//   node tools/make-kinds.js schema.json --lock .terraform.lock.hcl -o src/data/collection-kinds.json
//
//   The schema covers every provider the configuration uses (AWS and Google
//   together, say); each gets its own entry in meta.providers. Each needs its
//   version, which the schema file does not record: --lock reads it from
//   .terraform.lock.hcl, or give it as --version aws=5.100.0 (repeatable). A
//   bare --version X.Y.Z is accepted only when the schema holds one provider.
//   The app uses the recorded versions to warn when a plan targets a
//   different major version. `npm run build` bundles the output file.

const fs = require("fs");

const args = process.argv.slice(2);
function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node tools/make-kinds.js <schema.json> [--lock .terraform.lock.hcl] [--version name=X.Y.Z ...] -o <out.json>");
  process.exit(2);
}
let src = null, out = null, lock = null;
const versions = {};          /* short name -> version, from --version name=X */
let bareVersion = null;       /* --version X, for a single-provider schema */
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-o") out = args[++i];
  else if (a === "--lock") lock = args[++i];
  else if (a === "--version") {
    const v = args[++i] || "";
    const eq = v.indexOf("=");
    if (eq > 0) versions[v.slice(0, eq)] = v.slice(eq + 1);
    else bareVersion = v;
  }
  else if (!src) src = a;
  else usage("unexpected argument: " + a);
}
if (!src || !out) usage();

/* provider "registry.terraform.io/hashicorp/aws" { version = "5.100.0" ... } */
const locked = {};
if (lock) {
  const text = fs.readFileSync(lock, "utf8");
  for (const m of text.matchAll(/provider\s+"([^"]+)"\s*\{[^}]*?\bversion\s*=\s*"([^"]+)"/g)) locked[m[1]] = m[2];
}

const schema = JSON.parse(fs.readFileSync(src, "utf8"));
const result = { meta: { format: schema.format_version || null, providers: {} }, kinds: {} };

const addrs = Object.keys(schema.provider_schemas || {});
if (bareVersion && addrs.length > 1) {
  usage("a bare --version is ambiguous: the schema has " + addrs.length + " providers (" + addrs.join(", ") +
        "). Use --lock or --version name=X.Y.Z for each.");
}
const missing = [];
for (const [addr, ps] of Object.entries(schema.provider_schemas || {})) {
  const short = addr.split("/").pop();
  const version = versions[short] || locked[addr] || bareVersion || null;
  if (!version) missing.push(addr);
  let types = 0;
  for (const [ty, spec] of Object.entries(ps.resource_schemas || {})) {
    const block = spec.block || {};
    const m = {};
    for (const [name, a] of Object.entries(block.attributes || {})) {
      const t = a.type;
      if (Array.isArray(t) && ["set", "list", "map"].includes(t[0])) m[name] = t[0][0];
    }
    for (const [name, bt] of Object.entries(block.block_types || {})) {
      if (["set", "list", "map"].includes(bt.nesting_mode)) m[name] = bt.nesting_mode[0];
    }
    // record every type, even with no collections: absence must mean "this
    // provider version has no such resource", not "it has nothing to record"
    result.kinds[ty] = m;
    types++;
  }
  result.meta.providers[short] = { address: addr, version: version, types };
}

if (missing.length) {
  usage("no version for " + missing.join(", ") + ": pass --lock .terraform.lock.hcl or --version name=X.Y.Z");
}
const unused = Object.keys(versions).filter(n => !addrs.some(a => a.split("/").pop() === n));
if (unused.length) usage("--version given for a provider the schema does not have: " + unused.join(", "));

fs.writeFileSync(out, JSON.stringify(result));
const n = Object.keys(result.kinds).length;
console.log(`wrote ${out}: ${n} types, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
