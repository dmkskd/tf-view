// providers/gcp/placement.ts — GCP container hierarchy
//
// Places each network in the region box, each subnetwork in the network it
// references (or in the region box), and other resources in the subnetwork,
// or else the network, they reference.
import { PlacementApi, PlacementSession, ContainerRef, ProviderResource, asText } from "../../sdk/index.js";

function startGcpPlacement(api: PlacementApi): PlacementSession {
  var networkBox: Record<string, ContainerRef> = {};
  var subnetBox: Record<string, ContainerRef> = {};
  var byAddr: Record<string, ProviderResource> = {};
  api.resources.forEach(function(r: ProviderResource){ byAddr[r.addr] = r; });

  api.resources.forEach(function(r: ProviderResource){
    if (r.type !== "google_compute_network") return;
    networkBox[r.addr] = api.addContainer(api.region, {cls: "vpc", label: "VPC " + r.name, maxW: 1200, resource: r.addr});
  });

  api.resources.forEach(function(r: ProviderResource){
    if (r.type !== "google_compute_subnetwork") return;
    var network: ContainerRef | null = null;
    for (var i = 0; i < r.refs.length && !network; i++) network = networkBox[r.refs[i]] || null;
    subnetBox[r.addr] = api.addContainer(network || api.region, {cls: "subnet", label: "Subnet " + r.name,
      meta: asText(r.attrs.ip_cidr_range), maxW: 620, resource: r.addr});
  });

  return {
    containerOf: function(addr: string): ContainerRef | null {
      var r = byAddr[addr];
      if (!r) return null;
      for (var i = 0; i < r.refs.length; i++){
        var ref = r.refs[i];
        if (subnetBox[ref]) return subnetBox[ref];
        if (networkBox[ref]) return networkBox[ref];
      }
      return null;
    }
  };
}

export { startGcpPlacement };
