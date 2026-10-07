// core/redact.ts — replaces sensitive values in the parsed model
//
// `terraform show -json` writes sensitive values in clear text and marks them
// in a mask that mirrors the value's shape (after_sensitive, before_sensitive,
// sensitive_values): `true` at a position means the value there is sensitive.
// The parser uses these functions to replace each marked value with SENSITIVE
// while it builds the model, so the UI, the providers, HCL reconstruction and
// the parsed-model export read redacted values.
//
// Not covered: model.raw and model.rawText keep the file as loaded (the raw
// JSON panel in Plan info shows it), and a value Terraform does not mark as
// sensitive is not redacted.

export var SENSITIVE = "(sensitive value)";

/* Keys come from the plan, which is untrusted. Defining the property (rather
   than assigning it) makes a key named "__proto__" an ordinary property
   instead of setting the object's prototype. */
export function defineOwn(o: any, k: string, v: any): void {
  Object.defineProperty(o, k, {value: v, enumerable: true, writable: true, configurable: true});
}
var hasOwn = function(o: any, k: string): boolean { return Object.prototype.hasOwnProperty.call(o, k); };

/* A copy of value in which each position the mask marks `true` is replaced by
   SENSITIVE. Positions the mask does not mention are copied unchanged. */
export function redact(value: any, mask: any): any {
  if (mask === true) return value === undefined ? undefined : SENSITIVE;
  if (value === null || typeof value !== "object") return value;
  var m = (mask && typeof mask === "object") ? mask : null;
  if (Array.isArray(value)){
    return value.map(function(v: any, i: number){ return redact(v, m && Array.isArray(m) ? m[i] : undefined); });
  }
  var out: Record<string, any> = {};
  Object.keys(value).forEach(function(k: string){
    defineOwn(out, k, redact(value[k], m && !Array.isArray(m) && hasOwn(m, k) ? m[k] : undefined));
  });
  return out;
}

/* The union of two masks: a position marked in either is marked in the
   result. The parser applies the union of before_sensitive and
   after_sensitive to both the before and after values. */
export function unionMask(a: any, b: any): any {
  if (a === true || b === true) return true;
  var ao = a && typeof a === "object", bo = b && typeof b === "object";
  if (!ao && !bo) return a || b || undefined;
  if (!ao) return b;
  if (!bo) return a;
  if (Array.isArray(a) || Array.isArray(b)){
    var al = Array.isArray(a) ? a : [], bl = Array.isArray(b) ? b : [];
    var n = Math.max(al.length, bl.length), arr: any[] = [];
    for (var i = 0; i < n; i++) arr.push(unionMask(al[i], bl[i]));
    return arr;
  }
  var out: Record<string, any> = {};
  Object.keys(a).concat(Object.keys(b)).forEach(function(k: string){
    if (!hasOwn(out, k)) defineOwn(out, k, unionMask(hasOwn(a, k) ? a[k] : undefined, hasOwn(b, k) ? b[k] : undefined));
  });
  return out;
}

/* Converts a mask of `true` (the whole object is sensitive) into an object
   that marks every key found in `values`. Code that reads mask[k] then finds
   each key marked, and redaction keeps the object's shape
   ({password: SENSITIVE} rather than the string SENSITIVE). */
export function expandWholeMask(mask: any, values: any[]): any {
  if (mask !== true) return mask;
  var out: Record<string, boolean> = {};
  values.forEach(function(v: any){
    if (v && typeof v === "object" && !Array.isArray(v)) Object.keys(v).forEach(function(k: string){ defineOwn(out, k, true); });
  });
  return out;
}

/* True if the mask is `true` or contains `true` at any depth. An empty mask,
   [] or {}, marks nothing. */
export function marksAnything(mask: any): boolean {
  if (mask === true) return true;
  if (!mask || typeof mask !== "object") return false;
  var vals = Array.isArray(mask) ? mask : Object.keys(mask).map(function(k: string){ return mask[k]; });
  return vals.some(marksAnything);
}

/* A copy of a configuration resource (a configuration.root_module.resources[]
   entry) in which each literal the mask marks is replaced by SENSITIVE, at the
   level the mask marks it: the whole resource (all), an attribute, an element
   of a nested block list, or a field of such an element. References are
   addresses, not values, and are kept unless the whole attribute is marked.
   HCL reconstruction reads model.cfgByAddr, which holds these copies. */
export function redactConfig(cfg: any, mask: any, all: boolean): any {
  if (!cfg || typeof cfg !== "object") return cfg;
  var out: Record<string, any> = {};
  Object.keys(cfg).forEach(function(k: string){ if (k !== "expressions") defineOwn(out, k, cfg[k]); });
  var ex = cfg.expressions;
  if (ex && typeof ex === "object"){
    var safe: Record<string, any> = {};
    Object.keys(ex).forEach(function(k: string){
      defineOwn(safe, k, redactExpression(ex[k], all ? true : ownValue(mask, k)));
    });
    defineOwn(out, "expressions", safe);
  }
  return out;
}

function ownValue(m: any, k: string | number): any {
  return (m && typeof m === "object" && Object.prototype.hasOwnProperty.call(m, k)) ? m[k] : undefined;
}

var sensitiveExpression = function(): any { return {constant_value: SENSITIVE}; };

function redactExpression(e: any, m: any): any {
  if (m === true) return Array.isArray(e) ? e.map(function(){ return sensitiveExpression(); }) : sensitiveExpression();
  if (Array.isArray(e)){
    /* a repeated nested block: one expression map per element */
    return e.map(function(item: any, i: number){ return redactBlock(item, ownValue(m, i)); });
  }
  if (!e || typeof e !== "object") return e;
  var out: Record<string, any> = {};
  Object.keys(e).forEach(function(k: string){
    defineOwn(out, k, k === "constant_value" ? redact(e[k], m) : e[k]);
  });
  return out;
}

function redactBlock(item: any, mi: any): any {
  if (!item || typeof item !== "object") return item;
  var out: Record<string, any> = {};
  Object.keys(item).forEach(function(kk: string){
    defineOwn(out, kk, redactExpression(item[kk], mi === true ? true : ownValue(mi, kk)));
  });
  return out;
}
