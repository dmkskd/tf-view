// core/hooks.ts — calls a provider hook and validates its result
//
// callHook runs one hook, catches any exception, and passes the result to a
// check function before returning it. If the hook throws, or the check
// rejects the result, callHook returns the caller's fallback (no commands, no
// link, the unmodified value) and adds an error diagnostic to the plan, at
// most once per provider and hook. The callers (core/registry.ts,
// core/rules.ts) pass frozen inputs from core/readonly.ts.
//
// Used for cli, consoleUrl, tileSubtitle, sizing.blockHeight and the rules
// hooks. Placement is validated separately, in core/placement.ts.
import { state } from "./state.js";
import { PlanModel, ProviderPlugin, ProviderCommand, RuleListSpec, RuleDescription } from "../types/index.js";

export var REJECTED = {} as any;   /* returned (or thrown) by a check to reject a result */

/* Adds the diagnostic to `model`, or to the loaded plan (state.model) when
   none is given. Without either, the problem is not recorded. */
export function reportHookFailure(p: ProviderPlugin, hook: string, msg: string, model?: PlanModel | null): void {
  var m = model || state.model;
  if (!m || !m.diag) return;
  var code = "provider-" + p.id + "-" + hook;
  if ((m.diagnostics || []).some(function(d){ return d.code === code; })) return;
  m.diag("err", code, "The **" + p.id + "** provider's " + hook + " hook " + msg + "; its result was not used.");
}

export function callHook<T>(p: ProviderPlugin, hook: string, model: PlanModel | null | undefined,
                            run: () => unknown, check: (v: unknown) => T, fallback: T): T {
  var out: unknown;
  try { out = run(); }
  catch (e) { reportHookFailure(p, hook, "threw (" + exceptionMessage(e) + ")", model); return fallback; }
  var v: T;
  try { v = check(out); } catch (e) { v = REJECTED; }
  if (v === REJECTED){ reportHookFailure(p, hook, "returned a value that failed validation", model); return fallback; }
  return v;
}

function exceptionMessage(e: any): string {
  var m: any;
  try { m = e && e.message; } catch (x) { m = null; }
  return typeof m === "string" ? m.slice(0, 200) : "an exception";
}

/* ---- checks: each returns a copy of the accepted fields, or REJECTED ----- */

function isText(v: unknown, max: number): v is string { return typeof v === "string" && v.length <= max; }
function optText(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return v as null | undefined;
  if (!isText(v, max)) throw REJECTED;
  return v;
}

export function checkText(max: number): (v: unknown) => string {
  return function(v: unknown){ return isText(v, max) ? v : REJECTED; };
}

export function checkUrl(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return isText(v, 2048) ? v : REJECTED;
}

export function checkHeight(v: unknown): number {
  return (typeof v === "number" && isFinite(v) && v >= 4 && v <= 200) ? v : REJECTED;
}

export function checkCommands(v: unknown): ProviderCommand[] {
  if (!Array.isArray(v) || v.length > 20) return REJECTED;
  return v.map(function(c: any){
    if (!c || !isText(c.label, 80) || !Array.isArray(c.argv) || !c.argv.length || c.argv.length > 64 ||
        !c.argv.every(function(a: unknown){ return isText(a, 2048); })) throw REJECTED;
    return {label: c.label, argv: c.argv.slice()};
  });
}

export function checkRuleDescription(v: unknown): RuleDescription {
  var t: any = v;
  if (!t || typeof t !== "object") return REJECTED;
  if (!isText(t.ports, 200) || !isText(t.service, 200) || !isText(t.protocol, 200) || !isText(t.peer, 2000)) return REJECTED;
  if (t.order !== undefined && !(typeof t.order === "number" && isFinite(t.order))) return REJECTED;
  return {
    ports: t.ports, service: t.service, protocol: t.protocol, peer: t.peer,
    number: optText(t.number, 50), action: optText(t.action, 50), description: optText(t.description, 2000),
    order: t.order
  };
}

export function checkRuleListSpec(v: unknown): RuleListSpec | null {
  if (v === null || v === undefined) return null;
  var s: any = v;
  if (typeof s !== "object" || !isText(s.title, 200) || !isText(s.name, 200) || !isText(s.note, 500) ||
      typeof s.ordered !== "boolean" || !Array.isArray(s.directions) || !s.directions.length || s.directions.length > 4) return REJECTED;
  var dirs = s.directions.map(function(d: any){
    if (!d || !isText(d.attr, 64) || !/^[a-z_][a-z0-9_]*$/.test(d.attr) || typeof d.inbound !== "boolean" || !isText(d.peerHeading, 50)) throw REJECTED;
    return {attr: d.attr, inbound: d.inbound, peerHeading: d.peerHeading};
  });
  var implicit = s.implicit === undefined ? undefined : checkRuleDescription(s.implicit);
  if (implicit === REJECTED) return REJECTED;
  return {title: s.title, name: s.name, ordered: s.ordered, note: s.note, directions: dirs, implicit: implicit};
}
