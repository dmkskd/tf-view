// check-parse.js — regression check for the plan parser and its validation.
//
// WHAT IT CHECKS
//   For several inputs: the resolved region and versions, the resource list
//   with each one's action, support status, references and dependents, the
//   plan summary counts, and every validation message produced.
//
//   Inputs are the bundled sample plus deliberately awkward ones: a state file
//   passed instead of a plan, a JSON object that is not a plan at all, and a
//   plan using a non-AWS provider with a nested module. Those cover the paths
//   where the parser is supposed to warn rather than guess.
//
// HOW TO USE IT
//   node tools/check-parse.js | diff tools/baseline/check-parse.txt -
//   node tools/check-parse.js > tools/baseline/check-parse.txt   (to re-record)

const { load } = require("./lib/app.js");
const app = load(process.argv[2]);
const { parsePlan } = app.exports;

const plans = {
  sample: app.samplePlan(),
  mixed: JSON.parse(require("fs").readFileSync(__dirname + "/../samples/mixed-aws-gcp/plan.json", "utf8")),
  statefile: {format_version:"1.0", values:{root_module:{resources:[]}}},
  garbage: {hello:"world"},
  foreignprov: {format_version:"1.2", resource_changes:[
      {address:"google_compute_instance.x", type:"google_compute_instance", name:"x", mode:"managed",
       change:{actions:["create"], after:{}, after_unknown:{}}},
      {address:"aws_quantum_thing.y", type:"aws_quantum_thing", name:"y", mode:"managed",
       change:{actions:["create"], after:{}, after_unknown:{}}}],
    configuration:{provider_config:{google:{name:"google"}}, root_module:{module_calls:{vpc:{}}}}}
};

const out = [];
for (const [name, plan] of Object.entries(plans)) {
  const m = parsePlan(plan, name);
  out.push("### " + name);
  out.push("  region=" + m.region + " tf=" + m.tfVersion + " fmt=" + m.formatVersion);
  out.push("  resources=" + m.resources.length + " types=" + Object.keys(m.typeCounts).length);
  out.push("  summary=" + JSON.stringify(m.summary || null));
  out.push("  outputs=" + (m.outputs ? Object.keys(m.outputs).length : 0) + " drift=" + JSON.stringify(m.drift || null));
  for (const d of m.diagnostics) out.push("  [" + d.level + "/" + d.code + "] " + d.msg);
  for (const r of m.resources)
    out.push("  " + r.addr + " act=" + r.action + " sup=" + r.supported +
             " kind=" + r.kind + " refs=[" + r.refs.join(",") + "] deps=[" + (r.dependents||[]).join(",") + "]");
}
console.log(out.join("\n"));
