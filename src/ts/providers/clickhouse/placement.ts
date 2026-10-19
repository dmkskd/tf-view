// providers/clickhouse/placement.ts — ClickHouse Cloud container hierarchy
//
// Region box
//   one box per cloud and region a service runs in ("AWS us-east-2")
//     a warehouse box, when two or more services share data
//       one box per service, holding the settings that reference it
//       (private endpoints, schedules, queries)
//     ClickPipes, their CDC infrastructure and reverse private endpoints,
//     next to the warehouse: they run on ClickPipes compute, not on the
//     service's replicas, and the reference to the service draws the line
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

/* "3 × 8 GiB · read-only · auto-idle 5 min": replicas (num_replicas, or the
   min_replicas–max_replicas band) and memory per replica. */
function serviceMeta(r: ProviderResource): string {
  var c = serviceCompute(r);
  var out: string[] = [];
  var n = c.replicas ? rangeText(c.replicas) : "";
  if (c.memory){
    /* vCPU and totals are in the hover card (summary): the header text sets the box width */
    out.push((n ? n + " \u00d7 " : "") + rangeText(c.memory) + " GiB");
  } else if (n){
    out.push(n + (n === "1" ? " replica" : " replicas"));
  }
  if (r.attrs.readonly === true) out.push("read-only");
  /* auto-idling: compute stops after idle_timeout_minutes without queries */
  if (r.attrs.idle_scaling === true){
    var t = r.attrs.idle_timeout_minutes;
    out.push("auto-idle" + (typeof t === "number" ? " " + t + " min" : ""));
  }
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

  var warehouseBox: Record<string, ContainerRef> = {};
  Object.keys(members).forEach(function(root: string){
    var group = members[root];
    if (group.length < 2) return;
    var r = services[primaryOfGroup(group)];
    var box = api.addContainer(regionBoxFor(r), {cls: "vpc-wide warehouse",
      label: "Warehouse " + (asText(r.attrs.name) || r.name), meta: "shared data", maxW: 1300});
    group.forEach(function(a: string){ warehouseBox[a] = box; });
  });

  var serviceBox: Record<string, ContainerRef> = {};
  serviceAddrs.forEach(function(addr: string){
    var r = services[addr];
    var w = warehouseBox[addr];
    serviceBox[addr] = api.addContainer(w || regionBoxFor(r), {cls: "cluster service",
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

  return {
    containerOf: function(addr: string): ContainerRef | null {
      var r = byAddr[addr];
      if (!r) return null;
      if (r.type === "clickhouse_postgres_service") return regionBoxFor(r);
      var o = owner(r);
      if (!o) return null;
      return o.pipes ? regionBoxFor(services[o.service]) : serviceBox[o.service];
    }
  };
}

export { startClickHousePlacement };
