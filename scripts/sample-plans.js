// One source of sample data for Vite and the standalone HTML builder.
const fs = require("node:fs");
const path = require("node:path");

const files = {
  "embedded-plan": "sample-plan.json",
  "embedded-plan-fullstack": "sample-plan-fullstack.json",
  "embedded-plan-eks": "sample-plan-eks.json",
  "embedded-plan-clickhouse": "sample-plan-clickhouse.json"
};

function samplePlanTags() {
  return Object.entries(files).map(([id, file]) => {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/data", file), "utf8"));
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    return `<script type="application/json" id="${id}">${json}</script>`;
  }).join("\n");
}

module.exports = { samplePlanTags };
