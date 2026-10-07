// core/schema.ts — Schema pruning, localStorage cache & kind lookups
import { escapeHtml, $ } from "./util.js";
import { state } from "./state.js";
import { getProviderByTypePrefix, getAllProviders } from "./registry.js";

var SCHEMA: any = null;                    /* {type: resource_schema}, from a dropped file */
var SCHEMA_META: any = null;               /* {provider, version, types}                   */
var KINDS: any = null, KINDS_META: any = null;  /* bundled collection-kind table                */

function loadKinds(): void {
  if (KINDS) return;
  try {
    var el = document.getElementById("collection-kinds");
    if (el && el.textContent) {
      var doc = JSON.parse(el.textContent);
      KINDS = doc.kinds || {};
      KINDS_META = doc.meta || {};
    } else {
      KINDS = {};
      KINDS_META = {};
    }
  } catch(e){ KINDS = {}; KINDS_META = {}; }
}

var KIND_WORD: Record<string, string> = {s:"set", l:"list", m:"map"};

function isSchemaFile(doc: any): boolean {
  return !!(doc && doc.provider_schemas);
}

function pruneSchema(doc: any, types: string[]): { schema: Record<string, any>; meta: { provider: string | null; version: string | null; types: number } } {
  var out: Record<string, any> = {}, meta = {provider: null as string | null, version: (doc.format_version || null) as string | null, types: 0};
  Object.keys(doc.provider_schemas || {}).forEach(function(prov: string){
    var rs = (doc.provider_schemas[prov] || {}).resource_schemas || {};
    types.forEach(function(t: string){
      if (rs[t] && !out[t]){ out[t] = rs[t]; meta.types++; }
    });
    if (meta.types && !meta.provider) meta.provider = prov.split("/").pop() || null;
  });
  return {schema:out, meta:meta};
}

function storeSchema(schema: any, meta: any): void {
  SCHEMA = schema; SCHEMA_META = meta;
  try {
    localStorage.setItem("tfplanview-schema", JSON.stringify({s:schema, m:meta}));
  } catch(e){ /* too large, or storage unavailable: keep it in memory only */ }
}

function restoreSchema(): void {
  try {
    var raw = localStorage.getItem("tfplanview-schema");
    if (!raw) return;
    var v = JSON.parse(raw);
    SCHEMA = v.s || null; SCHEMA_META = v.m || null;
  } catch(e){ SCHEMA = null; SCHEMA_META = null; }
}

/* A schema the user dropped is exact for their provider version, so it wins.
   Otherwise fall back to the bundled table. Returns
   "set" | "list" | "map" | "single" | "scalar", plus where it came from. */
function attrKind(type: string, key: string): string | null {
  var rs = SCHEMA && SCHEMA[type];
  if (rs && rs.block){
    var a = (rs.block.attributes || {})[key];
    if (a) return Array.isArray(a.type) ? a.type[0] : "scalar";
    var bt = (rs.block.block_types || {})[key];
    if (bt) return bt.nesting_mode;
  }
  loadKinds();
  var k = KINDS && KINDS[type] && KINDS[type][key];
  return k ? KIND_WORD[k] : null;
}

function kindSource(type: string, key: string): string | null {
  var rs = SCHEMA && SCHEMA[type];
  if (rs && rs.block &&
      (((rs.block.attributes || {})[key]) || ((rs.block.block_types || {})[key]))) {
    return "loaded schema";
  }
  loadKinds();
  if (KINDS && KINDS[type] && KINDS[type][key]){
    var p = getProviderByTypePrefix(type);
    var m = (p && bundledMeta(p.id)) || {};
    return (p ? p.id + " " : "") + (m.version || "bundled");
  }
  return null;
}

/* The bundled table's metadata for a provider id ({version, ...}), or null. */
function bundledMeta(id: string): any {
  loadKinds();
  return (KINDS_META && KINDS_META.providers && KINDS_META.providers[id]) || null;
}

/* Compares the bundled table with this plan, for the first registered
   provider in the plan that the table covers: its version against the
   plan's version constraint, and the plan's types missing from it. */
function schemaFit(): { bundled: string | null; unknown: string[]; constraint: string | null; mismatch: boolean; usingLoaded: boolean } {
  loadKinds();
  var currentModel = state.model;
  var types = Object.keys((currentModel && currentModel.typeCounts) || {});
  var covered = function(t: string): string | null {
    var p = getProviderByTypePrefix(t);
    return p && bundledMeta(p.id) ? p.id : null;
  };
  var inPlan: Record<string, boolean> = {};
  types.forEach(function(t: string){ var id = covered(t); if (id) inPlan[id] = true; });
  var main = getAllProviders().filter(function(p){ return inPlan[p.id]; })[0];
  var bundled = (main && bundledMeta(main.id).version) || null;

  /* KINDS holds every type in the provider, with {} when it has no
     collections, so absence genuinely means "this version has no such type" */
  var unknown = types.filter(function(t: string){
    return !!covered(t) && !(KINDS && KINDS[t]);
  });

  var constraint = main && currentModel && currentModel.providerVersionConstraints
    ? currentModel.providerVersionConstraints[main.id] : null;
  var wantMajor = constraint && (constraint.match(/(\d+)/) || [])[1];
  var haveMajor = bundled && bundled.split(".")[0];

  return {bundled:bundled, unknown:unknown, constraint:constraint || null,
          mismatch: !!(wantMajor && haveMajor && wantMajor !== haveMajor),
          usingLoaded: !!SCHEMA};
}

export {
  SCHEMA, SCHEMA_META, KINDS, KINDS_META, KIND_WORD,
  loadKinds, isSchemaFile, pruneSchema, storeSchema, restoreSchema,
  attrKind, kindSource, schemaFit
};

