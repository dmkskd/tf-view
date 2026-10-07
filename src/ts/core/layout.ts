// core/layout.ts — Nested box containment tree & measure/layout engine
import {
  placeAllContainers, containerOfResource, isContainerBoundary,
  getCloudRootLabel
} from "../providers/registry.js";
import { mkGroup } from "./tree.js";
import {
  PlanModel, PlanResource, RenderOptions, LayoutGroup,
  LayoutLeaf, LayoutNode, LayoutRow, LayoutContext
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

   Placement runs in passes, outermost first, because each pass needs
   the groups the previous one created. To support a new container
   type, add a pass here and mark the type kind:"group" in REG.
   ------------------------------------------------------------------ */

function buildTree(model: PlanModel, opts: RenderOptions): LayoutGroup {
  var cloud = mkGroup("cloud", getCloudRootLabel(model), "", 1500, true);
  var region = mkGroup("region", "Region", model.region || "region not resolved", 1420);
  var global = mkGroup("loose", "Global", "account-level", 760);
  var unplaced = mkGroup("loose", "Unplaced", "no vpc or subnet reference", 760);

  var ctx: LayoutContext = {
    vis: visibleResources(model, opts),
    opts: opts,
    vpcGroups: {}, vpcWideGroups: {}, subnetVpcGroups: {}, azGroups: {}, subnetGroups: {}, sgGroups: {}, ownerOf: {},
    referrers: {}, byAddr: {},
    cloud: cloud,
    region: region,
    global: global,
    unplaced: unplaced
  };

  /* reverse index of expressions[*].references, for resources that name no
     container themselves — aws_eip is referenced by aws_nat_gateway, never
     the other way round */
  ctx.vis.forEach(function(r: PlanResource){
    ctx.byAddr![r.addr] = r;
    (r.refs || []).forEach(function(ref: string){
      (ctx.referrers![ref] || (ctx.referrers![ref] = [])).push(r);
    });
  });

  cloud.children.push(region);

  placeAllContainers(ctx);
  placeRemaining(ctx);

  if (global.children.length) cloud.children.push(global);
  if (unplaced.children.length) cloud.children.push(unplaced);

  pruneEmpty(cloud, cloud, opts);
  measure(cloud);
  place(cloud, 0, 0);
  model.anc = ancestorChains(cloud);
  return cloud;
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

function containerOf(ctx: LayoutContext, r: PlanResource): LayoutGroup | null {
  var scope = r.spec && r.spec.scope;
  if (scope === "global") return ctx.global || null;
  if (scope === "region") return ctx.region;

  var c = containerOfResource(ctx, r);
  if (c) return c;

  if (scope === "vpc") return ctx.region;
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
    var n = ctx.byAddr && ctx.byAddr[hop[i]];
    if (!n || n === r) continue;
    var g = containerOf(ctx, n);
    if (g) return g;
  }
  return null;
}

function placeRemaining(ctx: LayoutContext): void {
  ctx.vis.forEach(function(r: PlanResource){
    /* r.kind === "group" already covers every container type (aws_vpc,
       aws_subnet, and any future provider's equivalents) — nothing else
       to add here. isContainerBoundary already covers a security group
       with members the same way, via the provider's own isBoundary. */
    if (r.kind === "group") return;
    if (isContainerBoundary(ctx, r)) return;
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
  tileHeight, mkGroup, measure, place, buildTree,
  visibleResources, containerOf, containerOfNeighbour,
  placeRemaining, pruneEmpty, ancestorChains
};
