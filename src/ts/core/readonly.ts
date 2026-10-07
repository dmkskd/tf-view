// core/readonly.ts — frozen copies of resources for provider hooks
//
// Provider hooks receive these copies instead of core's PlanResource objects:
// a deep copy of the ProviderResource fields, frozen at every level, made once
// per resource. A write to a frozen object throws in strict-mode code (the
// bundled app is strict mode) and is ignored otherwise; either way the model
// is not changed.
import { defineOwn } from "./redact.js";
import { PlanResource, ProviderResource, JsonValue } from "../types/index.js";

/* Deep copy of JSON-like data, frozen at every level. Keys are defined as own
   properties, so a plan key "__proto__" becomes an ordinary property instead
   of setting the copy's prototype. */
export function frozenCopy(v: any): any {
  if (v === null || typeof v !== "object") return v;
  var out: any = Array.isArray(v) ? [] : {};
  Object.keys(v).forEach(function(k: string){ defineOwn(out, k, frozenCopy(v[k])); });
  return Object.freeze(out);
}

/* Cached per PlanResource object. The copied fields do not change after
   parsing, and attrs and before are already redacted by then. */
var copies: WeakMap<PlanResource, ProviderResource> = new WeakMap();
export function frozenProviderResource(r: PlanResource): ProviderResource {
  var c = copies.get(r);
  if (!c){
    c = frozenCopy({
      addr: r.addr, type: r.type, name: r.name, module: r.module || "", action: r.action,
      attrs: (r.attrs && typeof r.attrs === "object") ? r.attrs : {},
      before: (r.before && typeof r.before === "object") ? r.before : null,
      refs: r.refs || [], spec: r.spec || null, providerBlock: r.providerBlock || null
    }) as ProviderResource;
    copies.set(r, c);
  }
  return c;
}

export function frozenJsonValue(e: any): JsonValue {
  return frozenCopy(e === undefined ? null : e) as JsonValue;
}
