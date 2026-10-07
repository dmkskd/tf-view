import { escapeHtml, html, raw } from "./util.js";
import { attrKind, kindSource } from "./schema.js";
import { isRuleAttr, ruleKey, ruleDiffRow } from "./rules.js";
import { PlanResource } from "../types/index.js";

/* --- what this plan changes, per resource --- */

/* terraform mirrors the value's shape in after_sensitive: `true` marks a
   sensitive value, but a list gives [] or [ ... ] and an object {}. Treating
   any truthy mirror as sensitive masked whole collections that were not
   sensitive at all. Only an explicit true, or a true somewhere inside, counts. */
function isSensitive(mirror: any): boolean {
  if (mirror === true) return true;
  if (!mirror || typeof mirror !== "object") return false;
  var vals = Array.isArray(mirror) ? mirror : Object.keys(mirror).map(function(k: string){ return mirror[k]; });
  return vals.some(isSensitive);
}

function sameVal(a: any, b: any): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch(e){ return a === b; }
}

/* The names of the attributes this plan changes on a resource, sorted;
   includes keys whose sensitive value changed. */
function changedKeys(r: PlanResource): string[] {
  if (r.action === "create" || r.action === "no-op") return [];
  var before: Record<string, any> = r.before || {}, after: Record<string, any> = r.attrs || {}, keys: string[] = [];
  Object.keys(before).concat(Object.keys(after)).forEach(function(k: string){
    if (keys.indexOf(k) < 0 && !sameVal(before[k], after[k])) keys.push(k);
  });
  Object.keys(r.unknown || {}).forEach(function(k: string){
    if ((r.unknown as any)[k] === true && keys.indexOf(k) < 0 && before[k] !== undefined) keys.push(k);
  });
  (r.changedSensitiveKeys || []).forEach(function(k: string){ if (keys.indexOf(k) < 0) keys.push(k); });
  return keys.sort();
}

function valText(v: any, sensitive: boolean): string {
  if (sensitive === true) return "(sensitive value)";
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v, null, 1);
  return String(v);
}

function forcesReplace(r: PlanResource, key: string): boolean {
  return (r.replacePaths || []).some(function(path: any){
    return Array.isArray(path) ? path[0] === key : path === key;
  });
}

/* terraform's action_reason enum, as sentences */
var ACTION_REASON: Record<string, string> = {
  replace_because_cannot_update:
    "Must be replaced: an attribute changed that cannot be updated in place.",
  replace_because_tainted:
    "Must be replaced: the resource is marked tainted.",
  replace_by_request:
    "Replacement was requested explicitly, with -replace.",
  delete_because_no_resource_config:
    "Destroyed: no longer declared in the configuration.",
  delete_because_no_module:
    "Destroyed: the module holding it was removed.",
  delete_because_wrong_repetition:
    "Destroyed: count or for_each no longer produces this instance.",
  delete_because_count_index:
    "Destroyed: delete_because_count_index",
  delete_because_each_key:
    "Destroyed: its for_each key is no longer present.",
  read_because_config_unknown:
    "Read during apply: the configuration is not known yet.",
  read_because_dependency_pending:
    "Read during apply: a dependency has not been created yet."
};

function reasonText(r: PlanResource): string | null {
  var base = r.actionReason ? ACTION_REASON[r.actionReason] : null;
  if (!base){
    /* an enum this build has not seen: say so plainly rather than guess */
    return r.actionReason
      ? "Terraform reason: " + String(r.actionReason).replace(/_/g, " ") + "."
      : null;
  }
  var forced = (r.replacePaths || []).map(function(pp: any){
    return Array.isArray(pp) ? pp[0] : pp;
  });
  if (forced.length && r.actionReason === "replace_because_cannot_update"){
    return "Must be replaced: <code>" + escapeHtml(forced.join("</code>, <code>")) +
           "</code> cannot be changed in place.";
  }
  return escapeHtml(base);
}

/* A set is matched by content, a list by position. Without a schema the
   kind is unknown, so content matching is assumed and labelled as such. */
/* Match two rule lists and return [{rule, mark}], where mark is
   "+", "-" or "". A set matches by content, a list by position. */
function matchRules(before: any, after: any, kind?: string | null, r?: any): { rule: any; mark: string }[] {
  var b = Array.isArray(before) ? before : [];
  var a = Array.isArray(after) ? after : [];
  var out: { rule: any; mark: string }[] = [];
  var getKey = function(e: any): string { return ruleKey(r, e); };

  if (kind === "list"){
    var n = Math.max(b.length, a.length);
    for (var i = 0; i < n; i++){
      var ob = b[i], oa = a[i];
      if (ob && oa && getKey(ob) === getKey(oa)) out.push({rule:oa, mark:""});
      else {
        if (ob) out.push({rule:ob, mark:"-"});
        if (oa) out.push({rule:oa, mark:"+"});
      }
    }
    return out;
  }

  var bk: Record<string, any> = {}, ak: Record<string, any> = {};
  b.forEach(function(e: any){ bk[getKey(e)] = e; });
  a.forEach(function(e: any){ ak[getKey(e)] = e; });
  b.forEach(function(e: any){ if (!(getKey(e) in ak)) out.push({rule:e, mark:"-"}); });
  a.forEach(function(e: any){ if (!(getKey(e) in bk)) out.push({rule:e, mark:"+"}); });
  a.filter(function(e: any){ return getKey(e) in bk; })
   .forEach(function(e: any){ out.push({rule:e, mark:""}); });
  return out;
}

function ruleDiffHtml(k: string, before: any, after: any, resOrType: any): string {
  var res = (resOrType && typeof resOrType === "object") ? resOrType : null;
  var type = res ? res.type : resOrType;
  var kind = attrKind(type, k);
  var rows = matchRules(before, after, kind, res).map(function(m: any){
    return ruleDiffRow(res, m.rule, m.mark);
  }).join("");

  if (!rows) rows = '<div class="rdiff-row kept"><span class="m">&nbsp;</span>' +
                    '<span class="p">no rules</span></div>';

  var src = kindSource(type, k);
  var tag = kind
    ? '<span class="kindtag ok" title="' + escapeHtml(type + "." + k) + ' is a ' + kind + ' \u2014 ' + escapeHtml(src || "schema") + '">' + escapeHtml(kind) + '</span>'
    : '<span class="kindtag" title="No schema entry for ' + escapeHtml(type + "." + k) +
      '. Matched by content. Drop a provider schema to be exact.">inferred</span>';

  return '<div class="rdiff">' + tag + rows + '</div>';
}

function changeHtml(r: PlanResource): { count: number; body: string } | null {
  if (r.action === "create" || r.action === "no-op") return null;

  var before = r.before || {}, after = r.attrs || {};
  var keys: Record<string, number> = {};
  Object.keys(before).forEach(function(k: string){ keys[k] = 1; });
  Object.keys(after).forEach(function(k: string){ keys[k] = 1; });
  Object.keys(r.unknown || {}).forEach(function(k: string){ if ((r.unknown as any)[k] === true) keys[k] = 1; });

  var secretChanged = r.changedSensitiveKeys || [];
  var rows = Object.keys(keys).sort().filter(function(k: string){
    if (r.unknown && (r.unknown as any)[k] === true) return !sameVal((before as any)[k], undefined);
    return secretChanged.indexOf(k) >= 0 || !sameVal((before as any)[k], (after as any)[k]);
  });

  if (!rows.length && r.action !== "delete") return null;

  var b = '<div class="diff">';
  var why = reasonText(r);
  if (why) b += '<div class="diff-reason">' + why + '</div>';
  if (r.action === "delete" && !why){
    b += '<div class="diff-reason">Destroyed. The values below are what exists today.</div>';
  }
  rows.forEach(function(k: string){
    var sens = isSensitive(r.sensitive && (r.sensitive as any)[k]);
    var isUnknown = !!(r.unknown && (r.unknown as any)[k] === true);
    var forced = forcesReplace(r, k);
    b += '<div class="diff-row' + (forced ? " forced" : "") + '">' +
           '<div class="dk">' + escapeHtml(k) +
             (forced ? '<span class="tagf">forces replacement</span>' : '') + '</div>';
    if (isRuleAttr(r, k, (before as any)[k], (after as any)[k]) && !isUnknown){
      b += ruleDiffHtml(k, (before as any)[k], (after as any)[k], r);
    } else if (r.action !== "delete"){
      b += '<div class="dv old">' + escapeHtml(valText((before as any)[k], sens)) + '</div>' +
           '<div class="dv new">' + (isUnknown ? '<i>known after apply</i>' : escapeHtml(valText((after as any)[k], sens))) + '</div>';
    } else {
      b += '<div class="dv old">' + escapeHtml(valText((before as any)[k], sens)) + '</div>';
    }
    b += '</div>';
  });
  b += '</div>';
  return {count: rows.length, body: b};
}

export {
  isSensitive, sameVal, changedKeys, valText, forcesReplace,
  ACTION_REASON, reasonText, isRuleAttr, ruleKey,
  matchRules, ruleDiffHtml, changeHtml
};

