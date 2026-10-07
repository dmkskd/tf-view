// check-layout.js — regression check for the layout engine.
//
// WHAT IT CHECKS
//   Builds the containment tree headlessly and prints every box: its kind,
//   label, position and size, nested to show what contains what, plus the
//   ancestor chain used to suppress redundant dependency edges.
//
//   It runs the bundled plan through three configurations — Topology, Topology
//   with association resources shown, and Changes — so a change to packing,
//   tile size or placement rules shows up as a coordinate diff.
//
// HOW TO USE IT
//   node tools/check-layout.js | diff tools/baseline/check-layout.txt -
//   node tools/check-layout.js > tools/baseline/check-layout.txt  (to re-record)

const { load } = require("./lib/app.js");
const app = load(process.argv[2]);
const { parsePlan, buildTree, tileHeight, setTileHeight } = app.exports;

const plans = {
  sample: app.samplePlan(),
  mixed: JSON.parse(require("fs").readFileSync(__dirname + "/../samples/mixed-aws-gcp/plan.json", "utf8")),
};
const modes = [
  {mode:"all", showAssoc:false, showUnsup:true, edges:"select"},
  {mode:"all", showAssoc:true,  showUnsup:true, edges:"select"},
  {mode:"changes", showAssoc:false, showUnsup:true, edges:"select"}
];

const out = [];
for (const [name, plan] of Object.entries(plans)) {
  for (const opts of modes) {
    const model = parsePlan(plan, name);
    model.resources.forEach(r => { r.enabledType = true; });  // what load() does
    setTileHeight(tileHeight(opts.mode));
    const tree = buildTree(model, opts);
    out.push(`### ${name} mode=${opts.mode} assoc=${opts.showAssoc} -> ${tree.w}x${tree.h}`);
    (function walk(g, d) {
      const pad = "  ".repeat(d + 1);
      const id = g.box ? `[${g.cls}] ${g.label} ${g.meta}` : `. ${g.res.addr}`;
      out.push(`${pad}${id}  @${g.x},${g.y} ${g.w}x${g.h}`);
      if (g.box) g.children.forEach(k => walk(k, d + 1));
    })(tree, 0);
    out.push("  anc=" + JSON.stringify(model.anc));
  }
}
console.log(out.join("\n"));
