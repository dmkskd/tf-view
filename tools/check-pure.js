// check-pure.js — regression check for the functions that do not touch the DOM.
//
// WHAT IT CHECKS
//   The reconstructed Terraform block, the AWS CLI recipes, the before/after
//   diffs (including rule-list matching) and the security group / network ACL
//   rule tables, for every resource in the plan bundled in index.html.
//
// HOW IT WORKS
//   Loads the core modules through tools/lib/app.js (esbuild, from src/ts) and
//   the bundled sample plan from dist/index.html. No browser.
//
// HOW TO USE IT
//   node tools/check-pure.js | diff tools/baseline/check-pure.txt -
//   Any difference is a behaviour change. If it was intended, re-record:
//   node tools/check-pure.js > tools/baseline/check-pure.txt

const { load } = require("./lib/app.js");
const app = load(process.argv[2]);
const { actionOf, catalogEntry, hclFor, cliCommands, changedKeys, changeHtml, rulesSection } = app.exports;

const out = [];
{
  const f = "sample";
  const plan = app.samplePlan();
  const cfg = {};
  for (const c of (plan.configuration?.root_module?.resources || [])) cfg[c.address] = c;

  for (const rc of plan.resource_changes) {
    const r = {
      addr: rc.address, type: rc.type, name: rc.name,
      action: actionOf(rc.change.actions),
      attrs: rc.change.after || {}, before: rc.change.before || null,
      unknown: rc.change.after_unknown || {}, sensitive: rc.change.after_sensitive || {},
      replacePaths: rc.change.replace_paths || [], actionReason: rc.action_reason || null,
      spec: catalogEntry(rc.type), kind: (catalogEntry(rc.type) || {}).kind || "node"
    };
    out.push("### " + f + " " + rc.address);
    out.push("ACTION " + r.action);
    out.push("HCL " + (hclFor(r, cfg[rc.address]) || "(none)"));
    out.push("CLI " + JSON.stringify(cliCommands(r, { defaultProviderSettings: { aws: { region: "us-east-1" } } })));
    out.push("CHANGED " + JSON.stringify(changedKeys(r)));
    const ch = changeHtml(r);
    out.push("DIFF " + (ch ? ch.count + "|" + ch.body : "(none)"));
    const rl = rulesSection(r);
    out.push("RULES " + (rl ? rl.title + "|" + rl.body : "(none)"));
  }
}
console.log(out.join("\n"));
