// core/rules.ts — renders rule lists (security groups, network ACLs, firewalls)
//
// Through ProviderRules, a provider identifies which resources have rule lists
// and describes each rule as plain-text fields. The functions below build
// the HTML for the detail pane, the diff rows and the hover card, and pass
// every provider-supplied string through escapeHtml.
import { escapeHtml } from "./util.js";
import { getProviderForResource } from "./registry.js";
import { frozenProviderResource, frozenJsonValue } from "./readonly.js";
import { callHook, checkRuleListSpec, checkRuleDescription, checkText } from "./hooks.js";
import { PlanResource, RuleSection, RuleListSpec, RuleDescription } from "../types/index.js";

/* Calls to the rules hooks, through callHook (core/hooks.ts), with frozen
   inputs (core/readonly.ts). */
export function ruleSetFor(r: PlanResource | null | undefined): RuleListSpec | null {
  var p = getProviderForResource(r);
  if (!r || !p || !p.rules) return null;
  var rules = p.rules, res = r;
  return callHook(p, "rules.ruleSet", null, function(){ return rules.ruleSet(frozenProviderResource(res)); }, checkRuleListSpec, null);
}

export function describeRule(r: PlanResource | null | undefined, e: any): RuleDescription {
  var p = getProviderForResource(r);
  var plain = {ports: "", service: "", protocol: "", peer: jsonOrEmpty(e)};
  if (!p || !p.rules) return plain;
  var rules = p.rules;
  return callHook(p, "rules.describe", null, function(){ return rules.describe(frozenJsonValue(e)); }, checkRuleDescription, plain);
}

function jsonOrEmpty(e: any): string {
  try { return JSON.stringify(e) || ""; } catch (x) { return ""; }
}

/* True if attribute k of r is one of its rule-list attributes and both the
   before and after values are lists or absent. */
export function isRuleAttr(r: PlanResource, k: string, a: any, b: any): boolean {
  var set = ruleSetFor(r);
  if (!set || !set.directions.some(function(d){ return d.attr === k; })) return false;
  return (Array.isArray(a) || a == null) && (Array.isArray(b) || b == null);
}

/* A key identifying one rule, used to match rules in the before and after
   lists. Without a provider, the key is the rule's JSON text, so only
   identical rules match. */
export function ruleKey(r: PlanResource | null | undefined, e: any): string {
  var p = getProviderForResource(r);
  if (!p || !p.rules) return jsonOrEmpty(e);
  var rules = p.rules;
  return callHook(p, "rules.key", null, function(){ return rules.key(frozenJsonValue(e)); }, checkText(4000), jsonOrEmpty(e));
}

/* Describes each rule; for an ordered list, sorts them by their `order`. */
export function describeRules(r: PlanResource, set: RuleListSpec, entries: any[]): RuleDescription[] {
  var rows = entries.map(function(e: any){ return describeRule(r, e); });
  if (set.ordered) rows.sort(function(a: RuleDescription, b: RuleDescription){ return (a.order || 0) - (b.order || 0); });
  return rows;
}

function esc(v: any): string { return escapeHtml(v == null ? "" : v); }

/* The detail pane's rule section: one table per direction, then the note. */
export function rulesSection(r: PlanResource): RuleSection | null {
  var set = ruleSetFor(r);
  if (!set) return null;
  var ordered = set.ordered;

  function cells(t: RuleDescription, svcClass: boolean, withDesc: boolean): string {
    return (ordered ? '<td>' + esc(t.number) + '</td>' : '') +
           '<td>' + esc(t.protocol) + '</td>' +
           '<td>' + esc(t.ports) + '</td>' +
           (svcClass ? '<td class="svc">' : '<td>') + esc(t.service) + '</td>' +
           '<td>' + esc(t.peer) +
             (withDesc && t.description ? '<br><span style="color:var(--faint)">' + esc(t.description) + '</span>' : '') +
           '</td>' +
           (ordered ? '<td class="' + (t.action === "deny" ? "deny" : "allow") + '">' + esc(t.action) + '</td>' : '');
  }

  function table(dir: string, peerHd: string, entries?: any): string {
    var h = '<div class="rules-cap">' + esc(dir) + '</div>';
    if (!Array.isArray(entries) || !entries.length) return h + '<div class="none">no ' + esc(dir) + ' rules</div>';
    h += '<table><thead><tr>' +
         (ordered ? '<th>#</th>' : '') +
         '<th>Proto</th><th>Ports</th><th></th><th>' + esc(peerHd) + '</th>' +
         (ordered ? '<th>Action</th>' : '') +
         '</tr></thead><tbody>';
    describeRules(r, set!, entries).forEach(function(t: RuleDescription){
      h += '<tr>' + cells(t, true, true) + '</tr>';
    });
    /* the implicit rule is a row of the same table, so its columns align */
    if (set!.implicit) h += '<tr class="implicit">' + cells(set!.implicit, false, false) + '</tr>';
    return h + '</tbody></table>';
  }

  var attrs: any = r.attrs || {};
  var own = function(k: string){ return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : undefined; };
  var out = '<div class="rules">';
  set.directions.forEach(function(d){ out += table(d.attr, d.peerHeading, own(d.attr)); });
  out += '<div class="none" style="padding-top:8px">' + esc(set.note) + '</div>';
  out += '</div>';
  return {title: set.title, body: out};
}

/* One row of a rule-list diff: mark is "+", "-" or "". */
export function ruleDiffRow(r: PlanResource, e: any, mark: string): string {
  var t = describeRule(r, e);
  var cls = mark === "+" ? "added" : (mark === "-" ? "removed" : "kept");
  return '<div class="rdiff-row ' + cls + '">' +
           '<span class="m">' + (mark === "+" || mark === "-" ? mark : " ") + '</span>' +
           '<span class="p">' + esc(t.ports) + '</span>' +
           '<span class="s">' + esc(t.service) + '</span>' +
           '<span class="pr">' + esc(t.protocol) + '</span>' +
           '<span class="pe">' + esc(t.peer) + (t.number != null ? ' #' + esc(t.number) : '') + '</span>' +
           (t.description ? '<span class="d">' + esc(t.description) + '</span>' : '') +
         '</div>';
}

/* One row of the hover card. */
export function ruleHoverRow(t: RuleDescription, inbound: boolean, showNumber: boolean, mark: string): string {
  var cls = mark === "+" ? "added" : mark === "-" ? "removed" : (t.action === "deny" ? "deny" : "allow");
  return '<div class="rp-rule ' + cls + '">' +
           '<span class="rp-mark">' + (mark === "+" || mark === "-" ? mark : "") + '</span>' +
           '<span class="rp-arrow">' + (inbound ? "←" : "→") + '</span>' +
           '<span class="rp-port">' + esc(t.ports) + '</span>' +
           '<span class="rp-svc">' + esc(t.service) + '</span>' +
           '<span class="rp-proto">' + esc(t.protocol) + '</span>' +
           '<span class="rp-peer">' + esc(t.peer) +
             (showNumber && t.number != null ? ' <span class="rp-no">#' + esc(t.number) + '</span>' : '') +
           '</span>' +
         '</div>';
}
