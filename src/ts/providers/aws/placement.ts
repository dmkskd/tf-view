// providers/aws/placement.ts — AWS VPC, Subnet, and Security Group container hierarchy
//
// Uses core's PlacementApi: reads frozen copies of the provider's resources
// and adds boxes with addContainer, keeping the returned ContainerRefs.
// startAwsPlacement runs once per layout; its maps live in its closure.
import { PlacementApi, PlacementSession, ContainerRef, ProviderResource, asText, referencedValues, singleReferencedValue } from "../../sdk/index.js";

/* Resource types whose network interfaces a security group protects. A launch
   template or subnet group can refer to an SG in configuration, but the SG
   protects the resulting interfaces, not that object. */
var SG_MEMBER_TYPES: Record<string, boolean> = {
  aws_instance: true, aws_lb: true, aws_alb: true, aws_db_instance: true,
  aws_rds_cluster: true, aws_vpc_endpoint: true, aws_lambda_function: true
};

function startAwsPlacement(api: PlacementApi): PlacementSession {
  var resources = api.resources;
  var vpcBox: Record<string, ContainerRef> = {};        /* vpc addr -> box */
  var subnetBox: Record<string, ContainerRef> = {};     /* subnet addr -> box */
  var subnetVpc: Record<string, ContainerRef> = {};     /* subnet addr -> its VPC box (or the region) */
  var boxResource: Record<ContainerRef, string> = {};   /* box -> the resource it draws */
  var vpcWide: Record<string, ContainerRef> = {};       /* vpc addr -> its "VPC-wide" row */
  var azBox: Record<string, ContainerRef> = {};
  var sgBoxes: Record<string, ContainerRef[]> = {};     /* sg addr -> one box per container */
  var clusterBox: Record<string, ContainerRef> = {};
  var ownerOf: Record<string, ContainerRef> = {};       /* member addr -> SG or cluster box */

  function add(into: ContainerRef, spec: any): ContainerRef {
    var ref = api.addContainer(into, spec);
    if (spec.resource) boxResource[ref] = spec.resource;
    return ref;
  }

  function vpcOf(r: ProviderResource): ContainerRef | null {
    var direct = singleReferencedValue(vpcBox, r.refs);
    if (direct) return direct;
    var matches = referencedValues(subnetBox, r.refs);
    if (!matches.length) return null;
    var first = boxResource[matches[0]];
    var vpc = first ? subnetVpc[first] : undefined;
    return vpc && matches.every(function(g: ContainerRef){
      return !!boxResource[g] && subnetVpc[boxResource[g]] === vpc;
    }) ? vpc : null;
  }

  function subnetOf(r: ProviderResource): ContainerRef | null {
    return singleReferencedValue(subnetBox, r.refs);
  }

  /* AZs are location boxes; resources spanning AZs belong in a separate row
     within their VPC, not beside the AZs as if they were another location.
     The row is created the first time a resource is placed in it. */
  function vpcWideOf(r: ProviderResource): ContainerRef | null {
    var vpc = vpcOf(r);
    var vpcAddr = vpc ? boxResource[vpc] : null;
    if (!vpc || !vpcAddr) return null;
    if (!vpcWide[vpcAddr]){
      vpcWide[vpcAddr] = add(vpc, {cls: "vpc-wide", label: "VPC-wide", meta: "spans or sits outside AZs",
                                   maxW: 2600, breakBefore: true});
    }
    return vpcWide[vpcAddr];
  }

  /* Where a resource would sit if security-group membership didn't exist:
     its own subnet, or VPC, or nothing. Security-group placement is built on
     top of this, never the other way round — a member's real location always
     comes from its own reference, never from a sibling it happens to share
     an SG with. */
  function networkContainer(r: ProviderResource): ContainerRef | null {
    var scope = r.spec && r.spec.scope;
    if (scope === "network") return vpcWideOf(r);
    return subnetOf(r) || vpcWideOf(r);
  }

  function placeVpcs(): void {
    resources.forEach(function(r: ProviderResource){
      if (r.type !== "aws_vpc") return;
      /* Wide enough that multiple AZ columns actually sit side by side (the
         real convention in AWS's own diagrams) instead of only fitting one
         per row and stacking regardless. A single VPC box on an otherwise
         empty row is never clipped even if it exceeds this. */
      vpcBox[r.addr] = add(api.region, {cls: "vpc", label: "VPC " + r.name,
        meta: asText(r.attrs.cidr_block) || "cidr unknown", maxW: 2600, resource: r.addr});
    });
  }

  /* Subnets nest in an availability-zone group inside their VPC. */
  function placeSubnets(): void {
    resources.forEach(function(r: ProviderResource){
      if (r.type !== "aws_subnet") return;
      var parentVpc = vpcOf(r) || api.region;
      var az = asText(r.attrs.availability_zone) || "availability zone unresolved";
      var key = parentVpc + "|" + az;
      if (!azBox[key]){
        /* stack — an AZ's subnets stack vertically in a fixed order,
           deliberately, not to save space: the same subnet role then lands
           on the same row in every AZ column, so columns stay comparable. */
        azBox[key] = add(parentVpc, {cls: "az", label: "Availability Zone", meta: az, maxW: 1100, stack: true});
      }
      var isPublic = r.attrs.map_public_ip_on_launch === true;
      subnetBox[r.addr] = add(azBox[key], {cls: isPublic ? "subnet" : "subnet private",
        label: (isPublic ? "Public subnet " : "Subnet ") + r.name,
        meta: asText(r.attrs.cidr_block) || "cidr unknown", maxW: 620, resource: r.addr});
      subnetVpc[r.addr] = parentVpc;
    });
  }

  /* A security group is drawn as a dashed boundary — but it has no location
     of its own, only whatever its members' real locations are, and members
     can genuinely be scattered (an instance in a subnet, a launch template
     with no subnet at all). So the boundary is drawn once per distinct
     container its members actually landed in, not once for the whole group:
     two members in the same subnet share one boundary there; a member with
     no resolvable location of its own gets its own boundary at the VPC level
     rather than borrowing a sibling's. An SG with no members at all is not a
     boundary. Another SG referencing it is a rule source, not a member, so
     SGs never nest in each other. */
  function placeSecurityGroups(): void {
    var sgRes: Record<string, ProviderResource> = {};
    resources.forEach(function(r: ProviderResource){ if (r.type === "aws_security_group") sgRes[r.addr] = r; });

    /* sgAddr -> container -> members in that container */
    var byContainer: Record<string, Map<ContainerRef, ProviderResource[]>> = {};
    var claimed: Record<string, boolean> = {};
    resources.forEach(function(r: ProviderResource){
      if (!SG_MEMBER_TYPES[r.type]) return;
      r.refs.forEach(function(a: string){
        if (!sgRes[a] || claimed[r.addr]) return;   /* first SG referenced wins */
        claimed[r.addr] = true;
        /* A member ambiguous even on its own (an ALB spanning two subnets, say)
           still falls back to the SG's own VPC, never all the way out to
           Region — it's genuinely still somewhere inside this VPC. */
        var container = networkContainer(r) || vpcWideOf(sgRes[a]) || api.region;
        var forSg = byContainer[a] || (byContainer[a] = new Map());
        (forSg.get(container) || forSg.set(container, []).get(container)!).push(r);
      });
    });

    Object.keys(sgRes).forEach(function(a: string){
      var byC = byContainer[a];
      if (!byC || !byC.size) return;                  /* empty SG stays a tile */
      var r = sgRes[a];
      var boxes: ContainerRef[] = sgBoxes[a] = [];
      byC.forEach(function(mem: ProviderResource[], container: ContainerRef){
        var g = add(container, {cls: "sg", label: "Security group " + r.name, meta: "", maxW: 620, resource: r.addr});
        boxes.push(g);
        mem.forEach(function(m: ProviderResource){ ownerOf[m.addr] = g; });
      });
    });
  }

  /* An EKS cluster with managed node groups is drawn as a container around its
     node groups. If a cluster has no node groups (e.g. Fargate only or unmanaged),
     it stays as an ordinary tile. */
  function placeEksClusters(): void {
    var clusterRes: Record<string, ProviderResource> = {};
    var clusterByName: Record<string, ProviderResource> = {};
    resources.forEach(function(r: ProviderResource){
      if (r.type === "aws_eks_cluster") {
        clusterRes[r.addr] = r;
        if (asText(r.attrs.name)) clusterByName[asText(r.attrs.name)] = r;
        clusterByName[r.name] = r;
      }
    });

    Object.keys(clusterRes).forEach(function(addr: string){
      var cRes = clusterRes[addr];
      var nodeGroups = resources.filter(function(r: ProviderResource){
        if (r.type !== "aws_eks_node_group") return false;
        var cName = asText(r.attrs.cluster_name);
        return (cName && clusterByName[cName] === cRes) ||
               r.refs.indexOf(cRes.addr) >= 0 ||
               r.refs.indexOf(cRes.type + "." + cRes.name) >= 0;
      });
      if (!nodeGroups.length) return; /* empty cluster stays a tile */

      var version = asText(cRes.attrs.version);
      var parentGroup = networkContainer(cRes) || vpcWideOf(cRes) || api.region;
      var g = clusterBox[addr] = add(parentGroup, {cls: "cluster eks", label: "EKS Cluster " + cRes.name,
        meta: version ? "k8s " + version : "", maxW: 760, resource: addr});
      nodeGroups.forEach(function(ng: ProviderResource){ ownerOf[ng.addr] = g; });
    });
  }

  placeVpcs();
  placeSubnets();
  placeSecurityGroups();
  placeEksClusters();

  var byAddr: Record<string, ProviderResource> = {};
  resources.forEach(function(r: ProviderResource){ byAddr[r.addr] = r; });

  return {
    containerOf: function(addr: string): ContainerRef | null {
      var r = byAddr[addr];
      if (!r) return null;
      if (ownerOf[addr]) return ownerOf[addr];
      var c = networkContainer(r);
      if (c) return c;
      /* No single container: use the first subnet or VPC the resource
         references, even if it references several (an ALB across two subnets
         is placed in the first). */
      for (var i = 0; i < (r.refs || []).length; i++){
        var ref = r.refs[i];
        if (subnetBox[ref]) return subnetBox[ref];
        if (vpcBox[ref]) return vpcBox[ref];
      }
      return null;
    }
  };
}

export { startAwsPlacement };
