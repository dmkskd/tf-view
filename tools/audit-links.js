// audit-links.js — how well does the viewer resolve a plan's dependencies?
//
// WHAT IT CHECKS
//   Terraform's saved graph (prior_state) is the ground truth for a resource
//   that already exists. The viewer reads dependencies from the plan's
//   configuration, which cannot see through locals. This parses the plan
//   twice, once without prior_state (configuration alone) and once with, and
//   reports every saved dependency the configuration alone cannot reach.
//
//   Terraform saves transitive dependencies too (a route is recorded as
//   depending on the EIP its NAT gateway uses), so one missing link would make
//   every edge after it look missing as well. A saved dependency therefore
//   counts as "direct" only when no other path in the graph explains it; the
//   direct ones are the real gaps, and the audit says whether the dependent's
//   configuration uses a local (the usual cause).
//
// HOW TO USE IT
//   node tools/audit-links.js path/to/plan.json
//   Needs a plan made against real state (so it carries prior_state), and a
//   built dist/index.html (npm run build).
//   Exits non-zero when a saved dependency is missing.

const fs = require("fs");
const { load } = require("./lib/app.js");

const file = process.argv[2];
if (!file) { console.error("usage: node tools/audit-links.js <plan.json>"); process.exit(2); }

const app = load();
const parsePlan = app.fn("parsePlan");
const buildTree = app.fn("buildTree");
const cfgKey = app.fn("cfgKey");

const plan = JSON.parse(fs.readFileSync(file, "utf8"));
if (!plan.prior_state) {
  console.error("this plan has no prior_state: there is no saved graph to check against.");
  console.error("make it against applied infrastructure (just capture, or terraform plan -out after an apply).");
  process.exit(2);
}

const withState = parsePlan(plan, "t");
const { prior_state, ...rest } = plan;
const configOnly = parsePlan(rest, "t");

/* is `to` reachable from `from` through the model's links, ignoring the one
   edge from -> to itself? */
function reaches(model, from, to, skipDirect) {
  const seen = new Set([from]), queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    const r = model.byAddr[cur];
    for (const n of (r ? r.refs : [])) {
      if (skipDirect && cur === from && n === to) continue;
      if (n === to) return true;
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  return false;
}

const usesLocal = (addr) => {
  const cfg = withState.cfgByAddr[cfgKey(addr)];
  return !!cfg && JSON.stringify(cfg.expressions || {}).includes('"local.');
};

/* an edge only the saved graph has, and that nothing else in the graph
   explains, is a gap in what the configuration told us */
let total = 0, transitive = 0;
const missing = [];
for (const r of withState.resources) {
  for (const to of (r.stateRefs || [])) {
    total++;
    if (reaches(withState, r.addr, to, true)) transitive++;
    else missing.push({ from: r.addr, to, local: usesLocal(r.addr) });
  }
}

const n = withState.resources.length;
const noLinks = configOnly.resources.filter(r => !r.refs.length && !(r.dependents || []).length);
const stillNoLinks = withState.resources.filter(r => !r.refs.length && !(r.dependents || []).length);

const unplaced = (model) => {
  const out = [];
  (function walk(g, inUnplaced) {
    const here = inUnplaced || (g.box && /^Unplaced/.test(g.label));
    if (!g.box) { if (here) out.push(g.res.addr); return; }
    g.children.forEach(k => walk(k, here));
  })(buildTree(model, { mode: "all", showAssoc: true, showUnsup: true, edges: "select" }), false);
  return out;
};
const unplacedBefore = unplaced(configOnly), unplacedAfter = unplaced(withState);

console.log(`${file}`);
console.log(`  ${n} resources, ${Object.keys(withState.cfgByAddr).length} configuration blocks`);
console.log("");
console.log("  saved dependencies the configuration alone does not give:");
console.log(`    ${total} total: ${transitive} explained by other links (transitive), ${missing.length} direct gaps`);
const byLocal = missing.filter(m => m.local).length;
console.log(`    of the direct gaps: ${byLocal} from a resource whose configuration uses a local, ${missing.length - byLocal} other`);
console.log("");
console.log(`  resources with no links at all:   ${noLinks.length} from configuration alone, ${stillNoLinks.length} with state`);
console.log(`  resources left in "Unplaced":     ${unplacedBefore.length} from configuration alone, ${unplacedAfter.length} with state`);

if (stillNoLinks.length) { console.log("\n  still unlinked:"); stillNoLinks.forEach(r => console.log("    " + r.addr)); }
if (unplacedAfter.length) { console.log("\n  still unplaced:"); unplacedAfter.forEach(a => console.log("    " + a)); }

const other = missing.filter(m => !m.local);
if (other.length) {
  console.log("\n  direct gaps NOT explained by a local (worth a look):");
  other.slice(0, 20).forEach(m => console.log(`    ${m.from}  ->  ${m.to}`));
  if (other.length > 20) console.log(`    ... and ${other.length - 20} more`);
}

/* per module: how many resources, and how many have a link */
const mods = {};
for (const r of withState.resources) {
  const m = r.module || "(root)";
  mods[m] = mods[m] || { n: 0, linked: 0 };
  mods[m].n++;
  if (r.refs.length || (r.dependents || []).length) mods[m].linked++;
}
console.log("\n  by module (resources, with at least one link):");
Object.keys(mods).sort().forEach(m => console.log(`    ${m.padEnd(46)} ${String(mods[m].n).padStart(3)}  ${String(mods[m].linked).padStart(3)}`));

process.exit(other.length ? 1 : 0);
