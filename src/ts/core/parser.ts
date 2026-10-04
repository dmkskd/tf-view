// core/parser.ts — Plan JSON parser, validators and reference extractor
import { escapeHtml } from "./util.js";
import { REG, isProviderSupported, isForeignType } from "../providers/registry.js";
import { buildConfigIndex, refsFor, addStateEdges, listRefs, moduleOf, ConfigIndex } from "./references.js";
import {
  PlanModel, PlanResource, ActionType, TerraformPlanJson,
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
    resources: [], byAddr: {}, cfgByAddr: {},
    driftDetails: [], checks: [], variables: {},
    region: null, diagnostics: [], typeCounts: {},
    summary: null,
    llmReview: llmReview
  };
  out.diag = function(level: "err" | "warn" | "ok" | "info", code: string, msg: string, detail?: string | string[] | null | any){
    out.diagnostics.push({level:level, code:code, msg:msg, detail:detail || null});
  };

  if (!checkShape(plan, out)) return out;
  readProviders(plan, out);
  var cfg = readConfiguration(plan, out);
  readResources(plan, out, cfg);
  normaliseRefs(out);
  addStateEdges(plan, out.resources);
  reportUnsupported(out);
  linkDependents(out);
  readExtras(plan, out);
  summarise(plan, out);

  var aws = out.resources.filter(function(r: PlanResource){ return !r.foreign; }).length;
  if (out.resources.length && !aws){
    out.diag("err", "no-aws", "No AWS resources to draw");
  }

  if (!out.diagnostics.length){
    out.diag("ok", "clean", "All resources recognised");
  }
  return out;
}

/* Is this a plan at all? Returns false when there is nothing to draw. */
function checkShape(plan: any, out: PlanModel): plan is TerraformPlanJson {
  if (!plan || typeof plan !== "object"){
    out.diag!("err", "not-json",
      "File is not a JSON object. Expected the output of <b>terraform show -json planfile</b>.");
    return false;
  }
  var fv = plan.format_version;
  if (!fv){
    out.diag!("warn", "no-format",
      "No <b>format_version</b> \u2014 this may not be a plan file. Parsing optimistically.");
  } else if (String(fv).split(".")[0] !== "1"){
    out.diag!("warn", "format-version", "Plan format <b>" + fv + "</b> is not implemented yet " +
      "\u2014 only format 1.x is understood. Rendering may be incomplete.");
  }
  if (!Array.isArray(plan.resource_changes)){
    if (plan.values || plan.planned_values){
      out.diag!("warn", "state-file", "No <b>resource_changes</b>. This looks like a state file " +
        "rather than a plan; reading <b>planned_values</b> instead.");
    } else {
      out.diag!("err", "no-resources", "No <b>resource_changes</b> array \u2014 nothing to draw.");
      return false;
    }
  }
  return true;
}

function readProviders(plan: TerraformPlanJson, out: PlanModel): void {
  var pcfg = (plan.configuration && plan.configuration.provider_config) || {};
  Object.keys(pcfg).forEach(function(k: string){
    var name = pcfg[k].name || k;
    if (!isProviderSupported(name)){
      out.diag!("warn", "provider", "Provider <b>" + escapeHtml(name) + "</b> is not implemented " +
        "yet \u2014 only <b>aws</b> resources are drawn.");
      return;
    }
    out.providerConstraint = pcfg[k].version_constraint || null;
    var rex = pcfg[k].expressions && pcfg[k].expressions.region;
    if (rex && rex.constant_value){ out.region = rex.constant_value; return; }
    if (rex && rex.references){
      var vn = String(rex.references[0]).replace(/^var\./, "");
      var vars = plan.variables || {};
      if (vars[vn] && vars[vn].value) out.region = vars[vn].value;
    }
  });
}

/* Containment and dependencies both come from configuration expressions,
   the only place the plan records them before apply. The configuration is
   nested by module; core/references.ts resolves it into qualified addresses. */
function readConfiguration(plan: TerraformPlanJson, out: PlanModel): ConfigIndex {
  var rootCfg = (plan.configuration && plan.configuration.root_module) || {};
  if (!rootCfg.resources && !rootCfg.module_calls){
    out.diag!("warn", "no-config", "No <b>configuration</b> block in this plan \u2014 " +
      "relationships cannot be read, so everything is drawn at the top level. " +
      "Re-run <b>terraform show -json</b> on the plan file (not the state).");
  }
  var idx = buildConfigIndex(plan);
  out.cfgByAddr = idx.byKey;
  return idx;
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
    var spec = REG[rc.type] || null;
    var foreign = isForeignType(rc.type);
    var res: PlanResource = {
      addr: rc.address, address: rc.address, type: rc.type, name: rc.name,
      mode: rc.mode || "managed",
      action: rc.change ? actionOf(rc.change.actions) : "no-op",
      attrs: (rc.change && (rc.change.after || rc.change.before)) || rc.values || {},
      before: (rc.change && rc.change.before) || null,
      unknown: (rc.change && rc.change.after_unknown) || {},
      sensitive: (rc.change && rc.change.after_sensitive) || {},
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
    out.diag!("warn", "foreign", "<b>" + escapeHtml(t) + "</b> \u00d7 " + foreign[t] +
      " \u2014 non-AWS resource, not implemented yet.");
  });
  Object.keys(unsup).sort().forEach(function(t: string){
    out.diag!("warn", "unsupported", "<b>" + escapeHtml(t) + "</b> \u00d7 " + unsup[t] +
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
  Object.keys(vars).forEach(function(n: string){ out.variables[n] = vars[n] && vars[n].value; });

  var oc: Record<string, any> | undefined = plan.output_changes;
  if (oc){
    out.outputs = {};
    Object.keys(oc).forEach(function(n: string){
      var ch = oc![n] || {};
      out.outputs![n] = {
        actions: ch.actions || [],
        after: ch.after,
        afterUnknown: ch.after_unknown === true,
        afterSensitive: ch.after_sensitive === true
      };
    });
  } else {
    out.outputs = null;
  }

  (plan.resource_drift || []).forEach(function(d: TerraformResourceDrift){
    var ch = d.change || {};
    out.driftDetails.push({
      address: d.address, type: d.type, name: d.name,
      before: ch.before || {}, after: ch.after || {}
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
    out.diag!("warn", "drift", "<b>" + n + "</b> resource" + (n > 1 ? "s" : "") +
      " drifted",
      plan.resource_drift.map(function(d: TerraformResourceDrift){ return d.address; }));
    out.drift = plan.resource_drift.map(function(d: TerraformResourceDrift){ return d.address; });
  }
  if (plan.errored){
    out.diag!("err", "errored", "Plan <b>errored</b>, cannot be applied");
  } else if (plan.applyable === false){
    out.diag!("warn", "not-applyable", "Plan is <b>not applyable</b>");
  }
}

export {
  actionOf, baseAddr, parsePlan, checkShape, readProviders,
  readConfiguration, readResources, reportUnsupported,
  linkDependents, readExtras, summarise
};
