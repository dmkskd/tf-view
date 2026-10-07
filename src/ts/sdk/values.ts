// sdk/values.ts — functions for reading plan values in a provider
//
// Plan values have the type JsonValue (any JSON value). These functions read
// them without type casts, and read own properties only.

import type { JsonValue } from "../types/index.js";

/* A scalar as a string: a string unchanged, a number or boolean converted;
   "" for anything else (null, a list, an object, undefined). */
export function asText(v: JsonValue | undefined): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/* The value at a path of object keys and list indexes, or undefined if any
   step is missing: valueAt(r.attrs, "tags", "Name"). */
export function valueAt(v: JsonValue | undefined, ...path: (string | number)[]): JsonValue | undefined {
  var cur: any = v;
  for (var i = 0; i < path.length; i++){
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, path[i])) return undefined;
    cur = cur[path[i]];
  }
  return cur;
}

/* The value if it is a list, otherwise []. */
export function asList(v: JsonValue | undefined): ReadonlyArray<JsonValue> {
  return Array.isArray(v) ? v : [];
}
