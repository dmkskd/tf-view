// core/layout.ts — Nested box containment tree & measure/layout engine
import { getAllProviders, getProviderForResource } from "./registry.js";
import { startPlacement } from "./placement.js";
import { mkGroup } from "./tree.js";
import {
  PlanModel, PlanResource, RenderOptions, LayoutGroup,
  LayoutLeaf, LayoutNode, LayoutRow, LayoutContext, ProviderPlugin
} from "../types/index.js";

var TW = 178, GAP = 10, PAD = 14, HEAD = 26;
var TH_FLAT = 66, TH_CHANGES = 88;      /* the Changes tile carries a diff line */
var TH = TH_FLAT;

function setTileHeight(h: number): void { TH = h; }

/* The taller tile only earns its space when there are diffs to print. */
function tileHeight(mode: string, hasEdits?: boolean): number {
  return (mode === "changes" && hasEdits) ? TH_CHANGES : TH_FLAT;
}

function measure(g: LayoutNode): LayoutNode {
  if (!g.box){ g.w = TW; g.h = TH; return g; }
  g.children.forEach(measure);
  var sortedChildren = g.children.slice().sort(function(a: LayoutNode, b: LayoutNode){
    if (a.box !== b.box) return a.box ? -1 : 1;
    return 0;
  });
  /* a group of plain tiles packs to a near-square grid so rows do not end
     half empty; mixed or stacked groups wrap on width. */
  var allLeaves = sortedChildren.length > 0 && sortedChildren.every(function(k: LayoutNode){ return !k.box; });
  var perRow = Infinity;
  if (g.stack) perRow = 1;
  else if (allLeaves){
    var fit = Math.max(1, Math.floor(((g.maxW || 0) + GAP) / (TW + GAP)));
    perRow = Math.min(fit, Math.ceil(Math.sqrt(sortedChildren.length)));
  }

  var rows: LayoutRow[] = [], cur: LayoutNode[] = [], curW = 0, curIsBox = false;
  function flush(): void { if (cur.length){ rows.push({items:cur, w:curW}); cur = []; curW = 0; } }
  sortedChildren.forEach(function(k: LayoutNode){
    if (k.box && k.breakBefore) flush();
    /* Boxes pack several-per-row too, same as tiles, so sibling containers
       sit side by side when they fit instead of always stacking one per
       row regardless of width. Boxes and tiles never share a row — only
       their own kind. g.stack forces a single column regardless of width:
       a deliberate, fixed arrangement a provider opts a container into
       (see mkGroup's stack argument), not a space-driven one. */
    if (k.box !== curIsBox) flush();
    var kw = k.w || TW;
    var add = (cur.length ? GAP : 0) + kw;
    var tooMany = cur.length >= perRow || (g.stack && cur.length >= 1);
    if (tooMany || (cur.length && curW + add > (g.maxW || 0))) flush();
    cur.push(k); curW += (cur.length > 1 ? GAP : 0) + kw;
    curIsBox = !!k.box;
  });
  flush();
  g._rows = rows;

  var innerW = 0, innerH = 0;
  rows.forEach(function(r: LayoutRow, i: number){
    innerW = Math.max(innerW, r.w);
    var rh = 0; r.items.forEach(function(k: LayoutNode){ rh = Math.max(rh, k.h || TH); });
    r.h = rh;
    innerH += rh + (i ? GAP : 0);
  });
  var labelW = (g.label.length * 7.4) + (g.meta ? g.meta.length * 6.2 + 8 : 0) + 30;
  /* whole pixels: fractional widths give sub-pixel borders and blurry edges */
  g.w = Math.ceil(Math.max(innerW, labelW, 120)) + PAD*2;
  g.h = innerH + HEAD + PAD;
  if (!sortedChildren.length) g.h = HEAD + 22;
  return g;
}

function place(g: LayoutNode, x: number, y: number): void {
  g.x = x; g.y = y;
  if (!g.box) return;
  var cy = y + HEAD;
  (g._rows || []).forEach(function(r: LayoutRow){
    var cx = x + PAD;
    r.items.forEach(function(k: LayoutNode){
      place(k, cx, cy);
      cx += (k.w || TW) + GAP;
    });
    cy += (r.h || TH) + GAP;
  });
}

/* ------------------------------------------------------------------
   Containment tree.

   Each provider with resources in the plan gets its own cloud box, with its
   own region, global and unplaced boxes, laid out by that provider's
   placement only. A resource with no provider plugin is added to the first
   provider's cloud. With one provider, its cloud box is the root of the
   tree; with several, the cloud boxes are children of a "clouds" box, which
   the CSS does not draw.
   ------------------------------------------------------------------ */

function buildTree(model: PlanModel, opts: RenderOptions): LayoutGroup {
  var vis = visibleResources(model, opts);
  var byProvider: Record<string, PlanResource[]> = {};
  var unowned: PlanResource[] = [];
  vis.forEach(function(r: PlanResource){
    var p = getProviderForResource(r);
    if (p) (byProvider[p.id] || (byProvider[p.id] = [])).push(r);
    else unowned.push(r);
  });
  var present = getAllProviders().filter(function(p: ProviderPlugin){ return byProvider[p.id]; });
  if (!present.length) present = getAllProviders().slice(0, 1);

  var clouds = present.map(function(p: ProviderPlugin, i: number){
    var cloudResources = (byProvider[p.id] || []).concat(i === 0 ? unowned : []);
    return buildCloud(model, opts, p, cloudResources);
  });

  var root: LayoutGroup;
  if (clouds.length === 1) root = clouds[0];
  else {
    root = mkGroup("clouds", "", "", 4000);
    root.children = clouds;
  }
  measure(root);
  place(root, 0, 0);
  model.anc = ancestorChains(root);
  return root;
}

/* Lays out one provider's cloud. If the provider's placement fails at any
   point (an exception, or an invalid addContainer call or containerOf
   answer), the cloud is discarded and laid out again without the provider's
   placement; every resource is then a tile, placed by core's rules (catalog
   scope, neighbours, Unplaced). */
function buildCloud(model: PlanModel, opts: RenderOptions, p: ProviderPlugin | undefined, vis: PlanResource[]): LayoutGroup {
  var first = layoutCloud(model, opts, p, vis, true);
  if (!first.error) return first.cloud;
  if (p) reportPlacementFailure(model, p, first.error);
  return layoutCloud(model, opts, p, vis, false).cloud;
}

function layoutCloud(model: PlanModel, opts: RenderOptions, p: ProviderPlugin | undefined, vis: PlanResource[],
                     withPlacement: boolean): { cloud: LayoutGroup; error: string | null } {
  var ctxRegion = p && model.defaultProviderSettings && model.defaultProviderSettings[p.id] && model.defaultProviderSettings[p.id].region;
  var cloud = mkGroup("cloud", (p && p.cloudLabel) || "Cloud", "", 1500, true);
  var region = mkGroup("region", "Region", ctxRegion || "region not resolved", 1420);
  var global = mkGroup("loose", "Global", (p && p.globalNote) || "not regional", 760);
  var unplaced = mkGroup("loose", "Unplaced", (p && p.unplacedNote) || "no container reference", 760);

  var ctx: LayoutContext = {
    vis: vis,
    opts: opts,
    /* keyed by plan addresses: no prototype, see parsePlan */
    referrers: Object.create(null), byAddr: Object.create(null),
    cloud: cloud,
    region: region,
    global: global,
    unplaced: unplaced,
    provider: p || null,
    session: null,
    boxesByRef: new Map(),
    boxedAddresses: new Set()
  };

  /* reverse index of expressions[*].references, for resources that name no
     container themselves — aws_eip is referenced by aws_nat_gateway, never
     the other way round */
  ctx.vis.forEach(function(r: PlanResource){
    ctx.byAddr[r.addr] = r;
    (r.refs || []).forEach(function(ref: string){
      (ctx.referrers[ref] || (ctx.referrers[ref] = [])).push(r);
    });
  });

  cloud.children.push(region);

  if (withPlacement && p && p.placement){
    var own = ctx.vis.filter(function(r: PlanResource){ return getProviderForResource(r) === p; });
    var err = startPlacement(ctx, p, own, model);
    if (err) return { cloud: cloud, error: err };
  }
  placeRemaining(ctx);
  var late = ctx.error ? ctx.error() : null;
  if (late) return { cloud: cloud, error: late };

  if (global.children.length) cloud.children.push(global);
  if (unplaced.children.length) cloud.children.push(unplaced);

  pruneEmpty(cloud, cloud, opts);
  return { cloud: cloud, error: null };
}

/* Adds a placement-<id> error diagnostic, at most once per plan. */
function reportPlacementFailure(model: PlanModel, p: ProviderPlugin, msg: string): void {
  var code = "placement-" + p.id;
  if ((model.diagnostics || []).some(function(d){ return d.code === code; })) return;
  if (model.diag) model.diag("err", code, "The **" + p.id + "** provider's placement failed, so its resources are drawn as tiles, without its containers: " + msg);
}

function visibleResources(model: PlanModel, opts: RenderOptions): PlanResource[] {
  return model.resources.filter(function(r: PlanResource){
    if (r.hidden) return false;
    if (!r.enabledType) return false;
    if (r.kind === "assoc" && !opts.showAssoc) return false;
    if (!r.supported && !opts.showUnsup) return false;
    /* Changes shows the same diagram as Topology, with the plan marked on
       it. Hiding unchanged resources removed the context that makes the
       picture useful. Only an explicit action filter narrows it. */
    if (opts.action && r.kind !== "group" && r.action !== opts.action) return false;
    return true;
  });
}

/* The box for a resource's tile: by catalog scope ("global", "region"); else
   the box the provider's placement returns (for its own resources only);
   else, for scope "network", the region box; else null. */
function containerOf(ctx: LayoutContext, r: PlanResource): LayoutGroup | null {
  var scope = r.spec && r.spec.scope;
  if (scope === "global") return ctx.global;
  if (scope === "region") return ctx.region;

  var ref = ctx.session ? ctx.session.containerOf(r.addr) : null;
  if (ref) return ctx.boxesByRef.get(ref) || null;

  if (scope === "network") return ctx.region;
  return null;
}



/* One hop along a reference edge, either direction: a resource naming no
   container of its own takes the container of a neighbour — e.g. an EIP is
   reached from the NAT gateway that references it, or a policy attachment
   reaches the role it references. */
function containerOfNeighbour(ctx: LayoutContext, r: PlanResource): LayoutGroup | null {
  var hop = (r.refs || []).concat(
    ((ctx.referrers && ctx.referrers[r.addr]) || []).map(function(n: PlanResource){ return n.addr; }));
  for (var i = 0; i < hop.length; i++){
    var n = ctx.byAddr[hop[i]];
    if (!n || n === r) continue;
    var g = containerOf(ctx, n);
    if (g) return g;
  }
  return null;
}

function placeRemaining(ctx: LayoutContext): void {
  ctx.vis.forEach(function(r: PlanResource){
    /* A resource drawn as a box (a VPC, a subnet, a security group around
       its members; recorded from ContainerSpec.resource) is not also drawn as
       a tile. Every other visible resource is a tile, so each visible
       resource appears in the diagram whatever the provider's placement
       returns. */
    if (ctx.boxedAddresses.has(r.addr)) return;
    /* it did not become a boundary, so it is just a tile and the action
       filter applies to it like any other */
    if (ctx.opts && ctx.opts.action && r.action !== ctx.opts.action) return;

    var leaf: LayoutLeaf = {box:false, res:r};
    var g = containerOf(ctx, r) || containerOfNeighbour(ctx, r);
    var target = g || ctx.unplaced;
    if (target) target.children.push(leaf);
  });
}

/* In changes mode, a structural container (an AZ) left with nothing inside is noise. A container that is
   itself a resource (a subnet) stays even when empty and unchanged: it is dimmed, not removed. */
function pruneEmpty(g: LayoutNode, root: LayoutGroup, opts: RenderOptions): boolean {
  if (!g.box) return true;                         /* a tile is always kept */
  g.children = g.children.filter(function(k: LayoutNode){ return pruneEmpty(k, root, opts); });
  if (g === root) return true;
  return g.children.length > 0 ||
         !!g.res ||
         opts.mode !== "changes";
}

/* An edge between a resource and something that already encloses it is
   redundant: the nesting says it. */
function ancestorChains(root: LayoutGroup): Record<string, string[]> {
  var anc: Record<string, string[]> = {};
  (function walk(g: LayoutNode, chain: string[]){
    var next = chain;
    if (g.res){ anc[g.res.addr] = chain; next = chain.concat([g.res.addr]); }
    if (g.box) g.children.forEach(function(k: LayoutNode){ walk(k, next); });
  })(root, []);
  return anc;
}

export {
  TW, GAP, PAD, HEAD, TH_FLAT, TH_CHANGES, TH, setTileHeight,
  tileHeight, mkGroup, measure, place, buildTree, buildCloud,
  visibleResources, containerOf, containerOfNeighbour,
  placeRemaining, pruneEmpty, ancestorChains
};
