// Embeds a `terraform show -json` plan into the tfplanview single-file HTML.
// Mirrors inject_plan() in cli/src/main.rs.
// Usage: node inject.js <template.html> <plan.json> <label> > report.html
const fs = require('fs');
const [tpl, planFile, label] = process.argv.slice(2);
const html = fs.readFileSync(tpl, 'utf8');
const plan = fs.readFileSync(planFile, 'utf8');
JSON.parse(plan); // fail early on invalid input
const tag = ['injected-plan', 'embedded-plan']
  .map(id => `<script type="application/json" id="${id}">`)
  .find(t => html.includes(t));
if (!tag) throw new Error('template has no injected-plan/embedded-plan tag');
const start = html.indexOf(tag) + tag.length;
const end = html.indexOf('</script>', start);
const esc = s => s.replace(/</g, '\\u003c');
let out = html.slice(0, start) + esc(plan).trim() + html.slice(end);
const boot = `\n<script>\n  window.__TFVIEW_AUTOLOAD = true;\n  window.__TFVIEW_PLAN_LABEL = ${esc(JSON.stringify(label || 'terraform plan'))};\n</script>\n`;
const b = out.lastIndexOf('</body>');
if (b >= 0) out = out.slice(0, b) + boot + out.slice(b);
process.stdout.write(out);
