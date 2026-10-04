// dump-model.js — print what the viewer understood from a plan, as JSON.
//
// WHAT IT SHOWS
//   Each resource with its module, action, links (refs), the links only the
//   saved state supplied (stateRefs) and its dependents, plus the diagnostics.
//   Attribute values are left out unless --attrs is given (they can hold
//   secrets).
//
// HOW TO USE IT
//   node tools/dump-model.js path/to/plan.json            # JSON on stdout
//   node tools/dump-model.js path/to/plan.json --attrs    # include attributes
//   node tools/dump-model.js path/to/plan.json | jq '.resources[] | select(.refs == [])'
//   Needs a built dist/index.html (npm run build).

const fs = require("fs");
const { load } = require("./lib/app.js");

const file = process.argv[2];
if (!file) { console.error("usage: node tools/dump-model.js <plan.json> [--attrs]"); process.exit(2); }

const app = load();
const model = app.fn("parsePlan")(JSON.parse(fs.readFileSync(file, "utf8")), file);
console.log(JSON.stringify(app.fn("modelSnapshot")(model, process.argv.includes("--attrs")), null, 2));
