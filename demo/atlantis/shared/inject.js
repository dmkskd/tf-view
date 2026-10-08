// Embeds a `terraform show -json` plan into the tfplanview single-file HTML.
// Mirrors inject_plan() in cli/src/main.rs.
// Usage: node inject.js <template.html> <plan.json> <label> > report.html
const fs = require('fs');
const [tpl, planFile, label] = process.argv.slice(2);
const html = fs.readFileSync(tpl, 'utf8');
const plan_raw = fs.readFileSync(planFile, 'utf8');
const REDACTED = '(sensitive)';

// Terraform mirrors a value's shape in its *_sensitive mask: `true` marks a sensitive leaf,
// objects/arrays recurse. Returns the value with every masked leaf replaced.
function redact(value, mask) {
  if (mask === true) return REDACTED;
  if (!mask || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(mask) && Array.isArray(value)) return value.map((v, i) => redact(v, mask[i]));
  if (typeof mask === 'object' && !Array.isArray(mask) && !Array.isArray(value)) {
    const out = { ...value };
    for (const k of Object.keys(mask)) if (k in out) out[k] = redact(out[k], mask[k]);
    return out;
  }
  return value;
}
const hasSecret = m => m === true || (!!m && typeof m === 'object' && Object.values(m).some(hasSecret));

// Removes secret values from a `terraform show -json` plan, keeping its shape so the viewer still
// works. Covers resource/output changes, planned and prior state, sensitive variables, and the
// literals written in config for attributes that turned out sensitive, and sensitive variables' defaults. Not covered: secrets that
// terraform does not mark sensitive.
function redactPlan(p) {
  const sensKeys = new Map(); // address (module/resource indexes stripped) -> sensitive attribute names
  // indexes are quoted strings that may contain `]`: ["a]b"]
  const norm = a => a.replace(/\[(?:"(?:[^"\\]|\\.)*"|[^\]"])*\]/g, '');

  for (const rc of p.resource_changes || []) {
    const c = rc.change || {};
    const keys = new Set();
    for (const m of [c.before_sensitive, c.after_sensitive]) {
      if (m === true) { keys.add('*'); continue; }
      if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) if (hasSecret(v)) keys.add(k);
    }
    // instances of one resource (count, for_each) share one config block: keep every instance's keys
    if (keys.size) sensKeys.set(norm(rc.address), new Set([...(sensKeys.get(norm(rc.address)) || []), ...keys]));
    if ('before' in c) c.before = redact(c.before, c.before_sensitive);
    if ('after' in c) c.after = redact(c.after, c.after_sensitive);
  }
  // drift entries carry the same before/after and masks as planned changes
  for (const rd of p.resource_drift || []) {
    const c = rd.change || {};
    if ('before' in c) c.before = redact(c.before, c.before_sensitive);
    if ('after' in c) c.after = redact(c.after, c.after_sensitive);
  }
  for (const oc of Object.values(p.output_changes || {})) {
    if ('before' in oc) oc.before = redact(oc.before, oc.before_sensitive);
    if ('after' in oc) oc.after = redact(oc.after, oc.after_sensitive);
  }

  const walkModule = m => {
    for (const r of (m && m.resources) || []) r.values = redact(r.values, r.sensitive_values);
    for (const c of (m && m.child_modules) || []) walkModule(c);
  };
  const walkValues = v => {
    if (!v) return;
    walkModule(v.root_module);
    for (const o of Object.values(v.outputs || {})) if (o.sensitive) o.value = REDACTED;
  };
  walkValues(p.planned_values);
  walkValues(p.prior_state && p.prior_state.values);

  const walkConfig = (m, prefix) => {
    for (const k of Object.keys((m && m.variables) || {})) {
      if (!m.variables[k].sensitive) continue;
      if (!prefix && p.variables && k in p.variables) p.variables[k].value = REDACTED;
      if ('default' in m.variables[k]) m.variables[k].default = REDACTED;   // a sensitive variable's default is a secret too
    }
    for (const r of (m && m.resources) || []) {
      const keys = sensKeys.get(norm(prefix + r.address));
      if (!keys) continue;
      for (const k of Object.keys(r.expressions || {}))
        if (keys.has('*') || keys.has(k)) r.expressions[k] = { constant_value: REDACTED };
    }
    for (const [name, call] of Object.entries((m && m.module_calls) || {}))
      walkConfig(call.module, prefix + 'module.' + name + '.');
  };
  walkConfig(p.configuration && p.configuration.root_module, '');
  return p;
}

const plan = JSON.stringify(redactPlan(JSON.parse(plan_raw))); // also fails early on invalid input
// Fills only JSON data blocks and adds no script: the page's
// Content-Security-Policy allows only the page's own script (by hash), so the
// browser would block an added inline script. Each '<' becomes \u003c, so a
// block cannot contain the </script> that would end it early.
const esc = s => s.replace(/</g, '\\u003c');
function fillBlock(doc, id, json) {
  const tag = `<script type="application/json" id="${id}">`;
  const i = doc.indexOf(tag);
  if (i < 0) return null;
  const start = i + tag.length;
  const end = doc.indexOf('</script>', start);
  return doc.slice(0, start) + esc(json).trim() + doc.slice(end);
}
let out = fillBlock(html, 'injected-plan', plan) || fillBlock(html, 'embedded-plan', plan);
if (!out) throw new Error('template has no injected-plan/embedded-plan tag');
// "Show changes" on by default, so the report (and any screenshot of it) marks what the plan changes.
// SHOW_CHANGES=off keeps the viewer's own default.
// The report shows only this plan: VIEWER_ONLY=off brings back the Load and Samples buttons.
const config = JSON.stringify({
  autoload: true,
  viewerOnly: process.env.VIEWER_ONLY !== 'off',
  showChanges: process.env.SHOW_CHANGES !== 'off',
  label: label || 'terraform plan'
});
out = fillBlock(out, 'tfview-config', config);
if (!out) throw new Error('template has no tfview-config block; rebuild dist/index.html');
process.stdout.write(out);
