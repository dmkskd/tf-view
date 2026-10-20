// providers/clickhouse/placement.ts — ClickHouse Cloud container hierarchy
//
// Region box
//   one box per cloud and region a service runs in ("AWS us-east-2")
//     a Managed ClickHouse box
//       a warehouse box, when two or more services share data
//         one box per service, holding the settings that reference it
//         (private endpoints, schedules, queries)
//     a ClickPipes box on the next row: the pipes, their CDC infrastructure and
//     reverse private endpoints run on ClickPipes compute, not on the
//     service's replicas, and the reference to the service draws the line
//     a Managed Postgres box on a row of its own, holding the Postgres
//     services (a CDC ClickPipe reading one draws the line)
//
// Organization resources (API keys, roles, settings) have catalog scope
// "global" and go to the Global box.
import {
  PlacementApi, PlacementSession, ContainerRef, ProviderResource,
  asText, singleReferencedValue
} from "../../sdk/index.js";
import { serviceCompute, rangeText } from "./compute.js";

function regionLabel(r: ProviderResource): string {
  var cloud = asText(r.attrs.cloud_provider).toUpperCase();
  var region = asText(r.attrs.region);
  if (!cloud && !region) return "Location unknown";
  return (cloud || "cloud unknown") + " " + (region || "region unknown");
}

/* "3 × 8 GiB · read-only": replicas (num_replicas, or the
   min_replicas–max_replicas band) and memory per replica. vCPU, totals and
   auto-idle are in the hover card (summary). */
function serviceMeta(r: ProviderResource): string {
  var c = serviceCompute(r);
  var out: string[] = [];
  var n = c.replicas ? rangeText(c.replicas) : "";
  if (c.memory){
    out.push((n ? n + " \u00d7 " : "") + rangeText(c.memory) + " GiB");
  } else if (n){
    out.push(n + (n === "1" ? " replica" : " replicas"));
  }
  if (r.attrs.readonly === true) out.push("read-only");
  return out.join(" \u00b7 ");
}

/* Types that run on ClickPipes compute, outside the service. */
var CLICKPIPES: Record<string, boolean> = {
  clickhouse_clickpipe: true,
  clickhouse_clickpipe_cdc_infrastructure: true,
  clickhouse_clickpipes_reverse_private_endpoint: true
};

function startClickHousePlacement(api: PlacementApi): PlacementSession {
  var byAddr: Record<string, ProviderResource> = {};
  var services: Record<string, ProviderResource> = {};
  api.resources.forEach(function(r: ProviderResource){
    byAddr[r.addr] = r;
    if (r.type === "clickhouse_service") services[r.addr] = r;
  });

  /* Services share data (a warehouse) when one references another
     (warehouse_id = clickhouse_service.x.warehouse_id) or when both have the
     same known warehouse_id. Groups are joined transitively; a group of one
     service gets no warehouse box. */
  var leader: Record<string, string> = {};
  function find(a: string): string {
    while (leader[a] !== a) a = leader[a] = leader[leader[a]];
    return a;
  }
  function join(a: string, b: string): void { leader[find(a)] = find(b); }
  var serviceAddrs = Object.keys(services).sort();
  serviceAddrs.forEach(function(a: string){ leader[a] = a; });

  var referenced: Record<string, boolean> = {};
  var byWarehouseId: Record<string, string> = {};
  serviceAddrs.forEach(function(addr: string){
    var others: Record<string, string> = {};
    serviceAddrs.forEach(function(a: string){ if (a !== addr) others[a] = a; });
    var p = singleReferencedValue(others, services[addr].refs);
    if (p){ join(addr, p); referenced[p] = true; }
    var wid = asText(services[addr].attrs.warehouse_id);
    if (wid){
      if (byWarehouseId[wid]) join(addr, byWarehouseId[wid]);
      else byWarehouseId[wid] = addr;
    }
  });

  var members: Record<string, string[]> = {};
  serviceAddrs.forEach(function(a: string){
    var root = find(a);
    (members[root] || (members[root] = [])).push(a);
  });

  /* The primary names the box: the service the others reference, else the
     one marked is_primary, else the first by address. */
  function primaryOfGroup(group: string[]): string {
    var hit = group.filter(function(a: string){ return referenced[a]; });
    if (hit.length === 1) return hit[0];
    hit = group.filter(function(a: string){ return services[a].attrs.is_primary === true; });
    if (hit.length === 1) return hit[0];
    return group[0];
  }

  var regionBox: Record<string, ContainerRef> = {};
  function regionBoxFor(r: ProviderResource): ContainerRef {
    var key = regionLabel(r);
    return regionBox[key] || (regionBox[key] = api.addContainer(api.region, {cls: "az location", label: key, maxW: 1400}));
  }

  /* One Managed ClickHouse, one ClickPipes and one Managed Postgres box per
     region, one per row, so each product reads as its own group. */
  var clickhouseBox: Record<string, ContainerRef> = {};
  function clickhouseBoxFor(r: ProviderResource): ContainerRef {
    var key = regionLabel(r);
    return clickhouseBox[key] || (clickhouseBox[key] = api.addContainer(regionBoxFor(r),
      {cls: "vpc-wide clickhouse", label: "Managed ClickHouse", maxW: 1350}));
  }

  var pipesBox: Record<string, ContainerRef> = {};
  function pipesBoxFor(r: ProviderResource): ContainerRef {
    var key = regionLabel(r);
    return pipesBox[key] || (pipesBox[key] = api.addContainer(regionBoxFor(r),
      {cls: "vpc-wide clickpipes", label: "ClickPipes", meta: "pipes compute", maxW: 900, breakBefore: true}));
  }
  var postgresBox: Record<string, ContainerRef> = {};
  function postgresBoxFor(r: ProviderResource): ContainerRef {
    var key = regionLabel(r);
    return postgresBox[key] || (postgresBox[key] = api.addContainer(regionBoxFor(r),
      {cls: "vpc-wide postgres", label: "Managed Postgres", maxW: 900, breakBefore: true}));
  }

  var warehouseBox: Record<string, ContainerRef> = {};
  Object.keys(members).forEach(function(root: string){
    var group = members[root];
    if (group.length < 2) return;
    var r = services[primaryOfGroup(group)];
    var box = api.addContainer(clickhouseBoxFor(r), {cls: "vpc-wide warehouse",
      label: "Warehouse " + (asText(r.attrs.name) || r.name), meta: "shared data", maxW: 1300});
    group.forEach(function(a: string){ warehouseBox[a] = box; });
  });

  var serviceBox: Record<string, ContainerRef> = {};
  serviceAddrs.forEach(function(addr: string){
    var r = services[addr];
    var w = warehouseBox[addr];
    serviceBox[addr] = api.addContainer(w || clickhouseBoxFor(r), {cls: "cluster service",
      label: "Service " + (asText(r.attrs.name) || r.name), meta: serviceMeta(r), maxW: 900,
      resource: addr, edges: true});
  });

  api.resources.forEach(function(r: ProviderResource){
    if (r.type === "clickhouse_postgres_service") regionBoxFor(r);
  });

  var serviceOf: Record<string, string> = {};
  serviceAddrs.forEach(function(a: string){ serviceOf[a] = a; });

  /* The service a resource belongs to, and whether it is ClickPipes
     compute. One hop: custom DNS for a reverse endpoint goes with that
     endpoint. */
  function owner(r: ProviderResource): { service: string; pipes: boolean } | null {
    var s = singleReferencedValue(serviceOf, r.refs);
    if (s) return { service: s, pipes: !!CLICKPIPES[r.type] };
    for (var i = 0; i < r.refs.length; i++){
      var n = byAddr[r.refs[i]];
      if (n && !services[n.addr]){
        s = singleReferencedValue(serviceOf, n.refs);
        if (s) return { service: s, pipes: !!CLICKPIPES[n.type] };
      }
    }
    return null;
  }

  /* made before containerOf is asked, so the order is fixed: services,
     then ClickPipes, then Postgres */
  api.resources.forEach(function(r: ProviderResource){
    var o = owner(r);
    if (o && o.pipes) pipesBoxFor(services[o.service]);
  });
  api.resources.forEach(function(r: ProviderResource){
    if (r.type === "clickhouse_postgres_service") postgresBoxFor(r);
  });

  return {
    containerOf: function(addr: string): ContainerRef | null {
      var r = byAddr[addr];
      if (!r) return null;
      if (r.type === "clickhouse_postgres_service") return postgresBoxFor(r);
      var o = owner(r);
      if (!o) return null;
      return o.pipes ? pipesBoxFor(services[o.service]) : serviceBox[o.service];
    }
  };
}

export { startClickHousePlacement };
