// core/placement.ts — implements PlacementApi, the interface a provider's
// placement uses to add boxes to the layout
//
// startPlacement gives the provider frozen copies of its own resources
// (core/readonly.ts), its provider-block settings, and addContainer. The
// provider receives container references (strings such as "c3"), not layout
// objects, so it has no object with which to move, resize or reparent a box;
// and the references resolve only to boxes in its own cloud. Each
// addContainer call and each containerOf answer is validated here. On the
// first invalid call or exception, the layout code (core/layout.ts,
// buildCloud) discards the cloud, lays it out again without the provider's
// placement, and adds a placement-<id> error diagnostic to the plan.
import { mkGroup } from "./tree.js";
import { frozenProviderResource } from "./readonly.js";
import { settingsFor } from "./registry.js";
import {
  PlanModel, PlanResource, ProviderPlugin, LayoutContext, LayoutGroup,
  ContainerRef, ContainerSpec, PlacementApi, PlacementSession
} from "../types/index.js";

var CLASS_PATTERN = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*){0,3}$/;
var RESERVED_CLS = /(^| )(cloud|clouds|region|loose)( |$)/;   /* classes of the boxes core itself creates */
var MAX_TEXT = 200;
var MAX_CONTAINERS = 5000;

function validateContainerSpec(spec: any): string | null {
  if (!spec || typeof spec !== "object") return "spec is not an object";
  if (typeof spec.cls !== "string" || !CLASS_PATTERN.test(spec.cls)) return "cls must be lower-case words: " + JSON.stringify(spec.cls);
  if (RESERVED_CLS.test(spec.cls)) return "cls " + spec.cls + " is reserved for core";
  if (typeof spec.label !== "string" || spec.label.length > MAX_TEXT) return "label must be text up to " + MAX_TEXT + " characters";
  if (spec.meta != null && (typeof spec.meta !== "string" || spec.meta.length > MAX_TEXT)) return "meta must be text up to " + MAX_TEXT + " characters";
  if (spec.maxW != null && (typeof spec.maxW !== "number" || !(spec.maxW >= 100 && spec.maxW <= 6000))) return "maxW must be a number from 100 to 6000";
  if (spec.resource != null && typeof spec.resource !== "string") return "resource must be an address";
  return null;
}

/* Runs the provider's placement for one cloud and installs its session on
   ctx. Returns an error message if start() throws or makes an invalid
   addContainer call, otherwise null; errors after start() are reported
   through ctx.error. Container references and addresses arrive from the
   provider, so they are looked up in Maps: a value such as "__proto__" or
   "constructor" is an unknown key, not an inherited property. */
export function startPlacement(ctx: LayoutContext, p: ProviderPlugin, own: PlanResource[], model: PlanModel): string | null {
  var seq = 0, count = 0;
  var ownResources: Map<string, PlanResource> = new Map();
  own.forEach(function(r: PlanResource){ ownResources.set(r.addr, r); });
  function registerBox(g: LayoutGroup): ContainerRef {
    var id = "c" + (++seq);
    ctx.boxesByRef.set(id, g);
    return id;
  }
  ctx.boxesByRef = new Map();
  var regionRef = registerBox(ctx.region), globalRef = registerBox(ctx.global);

  var api: PlacementApi = Object.freeze({
    resources: Object.freeze(own.map(frozenProviderResource)),
    defaultSettings: Object.freeze(settingsFor(model, p)),
    settingsOf: function(addr: string){
      var r = typeof addr === "string" ? ownResources.get(addr) : undefined;
      return Object.freeze(r ? settingsFor(model, p, r) : {});
    },
    region: regionRef,
    global: globalRef,
    addContainer: function(parent: ContainerRef, spec: ContainerSpec): ContainerRef {
      var pg = typeof parent === "string" ? ctx.boxesByRef.get(parent) : undefined;
      if (!pg) throw new PlacementError("addContainer: unknown parent " + JSON.stringify(parent));
      var bad = validateContainerSpec(spec);
      if (bad) throw new PlacementError("addContainer: " + bad);
      var res = spec.resource != null ? ownResources.get(spec.resource) : undefined;
      if (spec.resource != null && !res) throw new PlacementError("addContainer: " + spec.resource + " is not one of this provider's resources");
      if (++count > MAX_CONTAINERS) throw new PlacementError("addContainer: more than " + MAX_CONTAINERS + " containers");
      var g = mkGroup(spec.cls, spec.label, spec.meta || "", spec.maxW, !!spec.stack);
      if (spec.breakBefore) g.breakBefore = true;
      if (res){ g.res = res; ctx.boxedAddresses.add(res.addr); }
      pg.children.push(g);
      return registerBox(g);
    }
  });

  var session: PlacementSession;
  try {
    session = p.placement.start(api);
    if (!session || typeof session.containerOf !== "function")
      throw new PlacementError("start() must return {containerOf}");
  } catch (e) {
    return exceptionMessage(e);
  }

  /* After start(): the first error is stored, and from then on containerOf
     returns null. buildCloud reads ctx.error() when placement finishes and,
     if it is set, lays the cloud out again without this provider. */
  var error: string | null = null;
  ctx.session = {
    containerOf: function(addr: string): ContainerRef | null {
      if (error || !ownResources.has(addr)) return null;
      try {
        var ref = session.containerOf(addr);
        if (ref == null) return null;
        if (typeof ref !== "string" || !ctx.boxesByRef.has(ref)) throw new PlacementError("containerOf(" + addr + ") returned an unknown container");
        return ref;
      } catch (e) {
        error = exceptionMessage(e);
        return null;
      }
    }
  };
  ctx.error = function(){ return error; };
  return null;
}

function exceptionMessage(e: any): string {
  if (e instanceof PlacementError) return e.message;
  var m: any;
  try { m = e && e.message; } catch (x) { m = null; }
  return "placement threw: " + (typeof m === "string" ? m : "an exception");
}

class PlacementError extends Error {}
