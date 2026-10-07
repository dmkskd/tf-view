// core/parser.ts — Plan JSON parser, validators and reference extractor
import {
  catalogEntry, getAllProviders, getProviderForProviderName, getProviderByTypePrefix, supportedProviderNames
} from "./registry.js";
import { redact, unionMask, marksAnything, expandWholeMask, redactConfig, SENSITIVE } from "./redact.js";
import { sameVal } from "./diff.js";
import { buildConfigIndex, refsFor, addStateEdges, listRefs, moduleOf, cfgKey, ConfigIndex } from "./references.js";
import {
  PlanModel, PlanResource, ActionType, TerraformPlanJson, DiagnosticItem,
  TerraformResourceChange, TerraformResourceDrift
} from "../types/index.js";

function actionOf(actions?: string[]): ActionType {
  if (!actions || !actions.length) return "no-op";
  var a = actions.join(",");
  if (a === "create,delete" || a === "delete,create") return "replace";
  if (actions.indexOf("create") >= 0) return "create";
  if (actions.indexOf("delete") >= 0) return "delete";
  if (actions.indexOf("update") >= 0) return "update";
  if (actions.indexOf("read") >= 0) return "read";
  return "no-op";
}

/* configuration.root_module.resources keys a count/for_each resource by its
   base address ("aws_subnet.public"), never a per-instance address
   ("aws_subnet.public[0]" or ["key"]) — strip the instance key before
   matching a resource_changes/state address against the configuration. */
function baseAddr(addr: string): string {
  return addr.replace(/\[[^\]]*\]$/, "");
}

function parsePlan(plan: TerraformPlanJson | any, sourceName: string): PlanModel {
  var llmReview = (plan && plan.annotations && plan.annotations.llm_review) || null;
  var out: PlanModel = {
    source: sourceName,
    tfVersion: (plan && plan.terraform_version) || null,
    formatVersion: (plan && plan.format_version) || null,
    /* keyed by plan addresses, which are untrusted: an object without a
       prototype, so "__proto__" or "constructor" is an ordinary key */
    resources: [], byAddr: Object.create(null), cfgByAddr: {},
    driftDetails: [], checks: [], variables: {},
    region: null, defaultProviderSettings: {}, providerBlocks: {}, providerVersionConstraints: {}, diagnostics: [], typeCounts: {},
    summary: null,
    llmReview: llmReview
  };
  out.diag = function(level: "err" | "warn" | "ok" | "info", code: string, msg: string, detail?: string | string[] | null | any, hint?: string){
    var d: DiagnosticItem = {level:level, code:code, msg:msg, detail:detail || null};
    if (hint) d.hint = hint;
    out.diagnostics.push(d);
  };

  if (!checkShape(plan, out)) return out;
  readProviders(plan, out);
  var cfg = readConfiguration(plan, out);
  readResources(plan, out, cfg);
  redactConfiguration(out, cfg);
  normaliseRefs(out);
  addStateEdges(plan, out.resources);
  reportUnsupported(out);
  linkDependents(out);
  readExtras(plan, out);
  summarise(plan, out);

  var drawable = out.resources.filter(function(r: PlanResource){ return !r.foreign; }).length;
  if (out.resources.length && !drawable){
    out.diag("err", "no-provider", "No resources from a supported provider to draw (supported: " +
      supportedProviderNames().map(function(t: string){ return "**" + t + "**"; }).join(", ") + ")");
  }
  out.region = mainRegion(out);

  if (!out.diagnostics.length){
    out.diag("ok", "clean", "All resources recognised");
  }
  return out;
}

/* Is this a plan at all? Returns false when there is nothing to draw. */
function checkShape(plan: any, out: PlanModel): plan is TerraformPlanJson {
  if (!plan || typeof plan !== "object"){
    out.diag!("err", "not-json",
      "File is not a JSON object. Expected the output of **terraform show -json planfile**.");
    return false;
  }
  var fv = plan.format_version;
  if (!fv){
    out.diag!("warn", "no-format",
      "No **format_version** \u2014 this may not be a plan file. Parsing optimistically.");
  } else if (String(fv).split(".")[0] !== "1"){
    out.diag!("warn", "format-version", "Plan format **" + fv + "** is not implemented yet " +
      "\u2014 only format 1.x is understood. Rendering may be incomplete.");
  }
  if (!Array.isArray(plan.resource_changes)){
    if (plan.values || plan.planned_values){
      out.diag!("warn", "state-file", "No **resource_changes**. This looks like a state file " +
        "rather than a plan; reading **planned_values** instead.");
    } else {
      out.diag!("err", "no-resources", "No **resource_changes** array \u2014 nothing to draw.");
      return false;
    }
  }
  return true;
}

/* Reads each provider block: the plugin that handles it (matched by
   full_name when the plan gives it, otherwise by name) and the values of the
   plugin's settingKeys, as strings. Each block is stored in providerBlocks
   by its key ("aws", "aws.west", "module.db:aws"), so a resource's hooks
   receive the settings of the block it uses. The default block (key equal to
   the provider name) is also stored in defaultProviderSettings. */
function readProviders(plan: TerraformPlanJson, out: PlanModel): void {
  var pcfg = (plan.configuration && plan.configuration.provider_config) || {};
  var vars = plan.variables || {};
  /* values of variables declared sensitive are excluded from provider settings */
  var declared: Record<string, any> = (plan.configuration && plan.configuration.root_module &&
                                       (plan.configuration.root_module as any).variables) || {};
  var usable: Record<string, any> = {};
  Object.keys(vars).forEach(function(n: string){
    if (!(declared[n] && declared[n].sensitive === true)) usable[n] = vars[n];
  });
  var unsupported: string[] = [];
  Object.keys(pcfg).forEach(function(k: string){
    var name = pcfg[k].name || k;
    var p = getProviderForProviderName(pcfg[k].full_name || name);
    if (!p){
      var shown = pcfg[k].full_name || name;
      if (unsupported.indexOf(shown) < 0) unsupported.push(shown);
      return;
    }
    /* a block inside a module refers to that module's variables, which are
       not in plan.variables, so only its literal values are read */
    var inModule = k.indexOf(":") >= 0;
    var settings: Record<string, string> = {};
    (p.settingKeys || []).forEach(function(key: string){
      var v = constantOrVariable(pcfg[k].expressions && pcfg[k].expressions[key], inModule ? {} : usable);
      if (v !== null) settings[key] = v;
    });
    out.providerBlocks[k] = {provider: p.id, settings: settings};
    var isDefault = k === name;
    if (!out.defaultProviderSettings[p.id] || isDefault) out.defaultProviderSettings[p.id] = settings;
    if (pcfg[k].version_constraint && (!out.providerVersionConstraints[p.id] || isDefault))
      out.providerVersionConstraints[p.id] = String(pcfg[k].version_constraint);
  });
  unsupported.forEach(function(name: string){
    out.diag!("warn", "provider", "Provider **" + name + "** is not implemented yet \u2014 only " +
      supportedProviderNames().map(function(t: string){ return "**" + t + "**"; }).join(", ") +
      " resources are drawn.");
  });
}

/* The key of the provider block a resource uses: its configuration's
   provider_config_key if that names a stored block; otherwise the same
   provider name one module level up, repeatedly
   ("module.a.module.b:aws" -> "module.a:aws" -> "aws"). */
function providerBlockOf(out: PlanModel, key: string | undefined): string | undefined {
  var k = key;
  while (k){
    if (out.providerBlocks[k]) return k;
    var colon = k.indexOf(":");
    if (colon < 0) return undefined;
    var mods = k.slice(0, colon), name = k.slice(colon + 1);
    var cut = mods.lastIndexOf(".module.");
    k = cut < 0 ? name : mods.slice(0, cut) + ":" + name;
  }
  return undefined;
}

/* A provider argument's value as a string, if it is a scalar literal or a
   reference to a variable in `vars` with a scalar value; otherwise null. */
function constantOrVariable(e: any, vars: Record<string, any>): string | null {
  if (!e) return null;
  if (e.constant_value !== undefined && e.constant_value !== null && typeof e.constant_value !== "object")
    return String(e.constant_value);
  if (e.references && e.references.length){
    var vn = String(e.references[0]).replace(/^var\./, "");
    if (!Object.prototype.hasOwnProperty.call(vars, vn) || !vars[vn]) return null;
    var v = vars[vn].value;
    if (v !== undefined && v !== null && typeof v !== "object") return String(v);
  }
  return null;
}

/* The region for the plan header: that of the first registered provider
   that has resources in the plan. */
function mainRegion(out: PlanModel): string | null {
  var present: Record<string, boolean> = {};
  out.resources.forEach(function(r: PlanResource){ if (r.provider) present[r.provider] = true; });
  var ps = getAllProviders();
  for (var i = 0; i < ps.length; i++){
    var ctx = out.defaultProviderSettings[ps[i].id];
    if (present[ps[i].id] && ctx && ctx.region) return ctx.region;
  }
  return null;
}

/* Containment and dependencies both come from configuration expressions,
   the only place the plan records them before apply. The configuration is
   nested by module; core/references.ts resolves it into qualified addresses. */
function readConfiguration(plan: TerraformPlanJson, out: PlanModel): ConfigIndex {
  var rootCfg = (plan.configuration && plan.configuration.root_module) || {};
  if (!rootCfg.resources && !rootCfg.module_calls){
    out.diag!("warn", "no-config", "No **configuration** block in this plan \u2014 " +
      "relationships cannot be read, so everything is drawn at the top level. " +
      "Re-run **terraform show -json** on the plan file (not the state).");
  }
  var idx = buildConfigIndex(plan);
  out.cfgByAddr = idx.byKey;
  return idx;
}

/* Builds model.cfgByAddr, the configuration the UI reads (for HCL
   reconstruction): a copy of each configuration resource redacted with the
   union of its instances' masks (count and for_each instances share one
   configuration entry). The unredacted index is used only inside the
   parser, to resolve references. */
function redactConfiguration(out: PlanModel, cfg: ConfigIndex): void {
  var masks: Record<string, any> = {}, all: Record<string, boolean> = {};
  out.resources.forEach(function(r: PlanResource){
    var k = cfgKey(r.addr);
    masks[k] = unionMask(masks[k], r.sensitive);
    if (r.wholeResourceSensitive) all[k] = true;
  });
  var safe: Record<string, any> = {};
  Object.keys(cfg.byKey).forEach(function(k: string){
    safe[k] = redactConfig(cfg.byKey[k], masks[k], !!all[k]);
  });
  out.cfgByAddr = safe;
}

function readResources(plan: TerraformPlanJson, out: PlanModel, cfg: ConfigIndex): void {
  var changes: (TerraformResourceChange | any)[] = Array.isArray(plan.resource_changes)
    ? plan.resource_changes
    : ((plan.planned_values && plan.planned_values.root_module &&
        plan.planned_values.root_module.resources) || []);

  var allAddrs: string[] = changes.filter(function(rc: any){ return rc.mode !== "data"; })
    .map(function(rc: any){ return rc.address; });

  changes.forEach(function(rc: any){
    if (rc.mode === "data") return;
    /* the provider plugin, by provider_name; by type prefix only if the
       input has no provider_name (a state file, a hand-written plan) */
    var plugin = rc.provider_name ? getProviderForProviderName(rc.provider_name) : getProviderByTypePrefix(rc.type);
    var cfgEntry = cfg.byKey[cfgKey(rc.address)];
    var blockKey = plugin ? providerBlockOf(out, cfgEntry && cfgEntry.provider_config_key) : undefined;
    if (blockKey && out.providerBlocks[blockKey].provider !== plugin!.id) blockKey = undefined;
    var spec = plugin ? catalogEntry(rc.type, plugin) : null;
    var foreign = !plugin;

    /* Redaction, once per resource: before and after are redacted with the
       union of both masks. Keys whose sensitive value changed are recorded
       first, because after redaction both sides read SENSITIVE. */
    var ch = rc.change || {};
    var rawAfter = ch.after || ch.before || rc.values || {};
    var rawBefore = ch.before || null;
    /* a mask of `true` (whole resource sensitive) is expanded to mark each key */
    var rawMask = unionMask(ch.after_sensitive || rc.sensitive_values, ch.before_sensitive);
    var mask = expandWholeMask(rawMask, [rawAfter, rawBefore, ch.after]) || {};
    var changedSensitiveKeys: string[] = [];
    if (rawBefore && ch.after){
      Object.keys(mask).forEach(function(k: string){
        if (marksAnything(mask[k]) && !sameVal(rawBefore[k], ch.after[k])) changedSensitiveKeys.push(k);
      });
    }
    var res: PlanResource = {
      addr: rc.address, address: rc.address, type: rc.type, name: rc.name,
      provider: plugin ? plugin.id : undefined, provider_name: rc.provider_name, providerBlock: blockKey,
      mode: rc.mode || "managed",
      action: rc.change ? actionOf(rc.change.actions) : "no-op",
      attrs: redact(rawAfter, mask),
      before: rawBefore ? redact(rawBefore, mask) : null,
      unknown: ch.after_unknown || {},
      sensitive: mask,
      changedSensitiveKeys: changedSensitiveKeys,
      wholeResourceSensitive: rawMask === true || undefined,
      replacePaths: (rc.change && rc.change.replace_paths) || [],
      actionReason: rc.action_reason || null,
      spec: spec, supported: !foreign && !!spec, kind: spec ? spec.kind : "node",
      /* the configuration keys a count/for_each resource by its base address
         and a module's resources relative to the module, never the
         per-instance qualified address resource_changes uses; refsFor joins
         the two. */
      module: rc.module_address || moduleOf(rc.address),
      refs: refsFor(cfg, rc.address, allAddrs),
      foreign: foreign,
      enabledType: true,
      llmInsight: (out.llmReview && out.llmReview.resources && out.llmReview.resources[rc.address]) || null
    };
    out.resources.push(res);
    out.byAddr[res.addr] = res;
    out.typeCounts[rc.type] = (out.typeCounts[rc.type] || 0) + 1;
  });
}

/* The configuration lists a reference at several levels of specificity (the
   instance and the bare resource together), names resources the plan has no
   instance of (a module's unused variant), and refers to a counted resource
   without an index when it means all of it. Settle that once, so every link is
   a real resource in this plan, listed once: duplicates collapse, what is not
   in the plan goes, and a bare name becomes its instances. */
function normaliseRefs(out: PlanModel): void {
  out.resources.forEach(function(r: PlanResource){
    r.refs = listRefs(r.refs, out.byAddr)
      .filter(function(x){ return x.inPlan && x.addr !== r.addr; })
      .map(function(x){ return x.addr; });
  });
}

function reportUnsupported(out: PlanModel): void {
  var unsup: Record<string, number> = {}, foreign: Record<string, number> = {};
  out.resources.forEach(function(r: PlanResource){
    if (r.foreign) foreign[r.type] = (foreign[r.type] || 0) + 1;
    else if (!r.supported) unsup[r.type] = (unsup[r.type] || 0) + 1;
  });
  Object.keys(foreign).sort().forEach(function(t: string){
    out.diag!("warn", "foreign", "**" + t + "** \u00d7 " + foreign[t] +
      " \u2014 no provider plugin draws this type yet.");
  });
  Object.keys(unsup).sort().forEach(function(t: string){
    out.diag!("warn", "unsupported", "**" + t + "** \u00d7 " + unsup[t] +
      " \u2014 not implemented yet; drawn as a generic tile with no placement rules.");
  });
}

function linkDependents(out: PlanModel): void {
  out.resources.forEach(function(r: PlanResource){ r.dependents = []; });
  out.resources.forEach(function(r: PlanResource){
    (r.refs || []).forEach(function(a: string){
      var t = out.byAddr[a];
      if (t) {
        if (!t.dependents) t.dependents = [];
        t.dependents.push(r.addr);
      }
    });
  });
}

/* The parts of a plan that are not resources: variables, outputs, drift and
   check results. Read once here into typed fields, so nothing downstream has
   to know the JSON layout (or whether the input was a plan or a state). */
function readExtras(plan: TerraformPlanJson, out: PlanModel): void {
  var vars: Record<string, any> = (plan as any).variables || {};
  var declared: Record<string, any> = (plan.configuration && plan.configuration.root_module &&
                                       (plan.configuration.root_module as any).variables) || {};
  Object.keys(vars).forEach(function(n: string){
    var secret = declared[n] && declared[n].sensitive === true;
    out.variables[n] = secret ? SENSITIVE : (vars[n] && vars[n].value);
  });

  var oc: Record<string, any> | undefined = plan.output_changes;
  if (oc){
    out.outputs = {};
    Object.keys(oc).forEach(function(n: string){
      var ch = oc![n] || {};
      out.outputs![n] = {
        actions: ch.actions || [],
        after: redact(ch.after, ch.after_sensitive),
        afterUnknown: ch.after_unknown === true,
        afterSensitive: ch.after_sensitive === true
      };
    });
  } else {
    out.outputs = null;
  }

  (plan.resource_drift || []).forEach(function(d: TerraformResourceDrift){
    var ch = d.change || {};
    var dmask = unionMask(ch.after_sensitive, ch.before_sensitive);
    out.driftDetails.push({
      address: d.address, type: d.type, name: d.name,
      before: redact(ch.before || {}, dmask), after: redact(ch.after || {}, dmask)
    });
  });

  ((plan as any).checks || []).forEach(function(c: any){
    var problems: string[] = [];
    (c.instances || []).forEach(function(i: any){
      (i.problems || []).forEach(function(pr: any){ problems.push(pr.message || ""); });
    });
    out.checks.push({
      name: (c.address && (c.address.to_display || c.address.kind)) || "check",
      status: c.status || "",
      problems: problems
    });
  });
}

function summarise(plan: TerraformPlanJson, out: PlanModel): void {
  out.summary = {create:0, update:0, replace:0, "delete":0, "no-op":0, read:0};
  out.resources.forEach(function(r: PlanResource){
    if (out.summary) {
      if (out.summary[r.action] === undefined) out.summary[r.action] = 0;
      out.summary[r.action]!++;
    }
  });

  if (Array.isArray(plan.resource_drift) && plan.resource_drift.length){
    var n = plan.resource_drift.length;
    out.diag!("warn", "drift", "**" + n + "** resource" + (n > 1 ? "s" : "") +
      " drifted",
      plan.resource_drift.map(function(d: TerraformResourceDrift){ return d.address; }));
    out.drift = plan.resource_drift.map(function(d: TerraformResourceDrift){ return d.address; });
  }
  if (plan.errored){
    out.diag!("err", "errored", "Plan **errored**, cannot be applied");
  } else if (plan.applyable === false){
    out.diag!("warn", "not-applyable", "Plan is **not applyable**");
  }
}

export {
  actionOf, baseAddr, parsePlan, checkShape, readProviders,
  readConfiguration, readResources, reportUnsupported,
  linkDependents, readExtras, summarise
};
