// providers/aws/console.ts — deep links into the AWS web console
import { ProviderResource, ProviderSettings, ConsoleHost, JsonValue, valueAt } from "../../sdk/index.js";

/* The AWS console hosts. With allowRegionPrefix, "<region>.<host>" also
   matches. core/links.ts returns a console link only if its host matches. */
var AWS_CONSOLE_HOSTS: ConsoleHost[] = [
  {host: "console.aws.amazon.com", allowRegionPrefix: true},
  {host: "console.amazonaws.cn", allowRegionPrefix: true},
  {host: "console.amazonaws-us-gov.com", allowRegionPrefix: true}
];

/* Console URLs are not a documented API; these templates follow the patterns
   the console has used for years. A link is only offered when the physical id
   is known, so resources being created (id "known after apply") get none. */

function consoleHost(region: string): string {
  if (region.indexOf("cn-") === 0) return "https://" + region + ".console.amazonaws.cn";
  if (region.indexOf("us-gov-") === 0) return "https://" + region + ".console.amazonaws-us-gov.com";
  return "https://" + region + ".console.aws.amazon.com";
}

function awsConsoleUrl(r: ProviderResource, settings: Readonly<ProviderSettings>): string | null {
  var region = settings.region;
  if (!region || !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) return null;
  var val = function(k: string): JsonValue | undefined {
    return valueAt(r.attrs, k) || (r.before ? valueAt(r.before, k) : undefined);
  };
  var id = val("id");
  var host = consoleHost(region), q = "?region=" + encodeURIComponent(region);

  /* IAM is global and addressed by name, not by id; the name is unknown when
     the role is built from name_prefix. */
  if (r.type === "aws_iam_role") {
    var name = val("name");
    if (typeof name !== "string" || !name) return null;
    var iamHost = host.replace(region + ".", "");
    return iamHost + "/iam/home#/roles/details/" + encodeURIComponent(name);
  }

  /* EKS is addressed by name too, and the name is in the plan even when the
     id is not. A node group lives under its cluster, so it needs both. */
  if (r.type === "aws_eks_cluster" || r.type === "aws_eks_node_group") {
    var cluster = r.type === "aws_eks_cluster" ? val("name") : val("cluster_name");
    if (typeof cluster !== "string" || !cluster) return null;
    var base = host + "/eks/clusters/" + encodeURIComponent(cluster);
    if (r.type === "aws_eks_cluster") return base + q;
    var ng = val("node_group_name");
    if (typeof ng !== "string" || !ng) return null;
    return base + "/nodegroups/" + encodeURIComponent(ng) + q;
  }

  if (typeof id !== "string" || !id) return null;
  var eid = encodeURIComponent(id);

  switch (r.type) {
    case "aws_instance":
      return host + "/ec2/home" + q + "#InstanceDetails:instanceId=" + eid;
    case "aws_security_group":
      return host + "/ec2/home" + q + "#SecurityGroup:securityGroupId=" + eid;
    case "aws_vpc":
      return host + "/vpcconsole/home" + q + "#VpcDetails:VpcId=" + eid;
    case "aws_subnet":
      return host + "/vpcconsole/home" + q + "#SubnetDetails:subnetId=" + eid;
    case "aws_route_table":
      return host + "/vpcconsole/home" + q + "#RouteTableDetails:RouteTableId=" + eid;
    case "aws_internet_gateway":
      return host + "/vpcconsole/home" + q + "#InternetGateway:internetGatewayId=" + eid;
    case "aws_nat_gateway":
      return host + "/vpcconsole/home" + q + "#NatGatewayDetails:natGatewayId=" + eid;
    case "aws_eip":
      return host + "/ec2/home" + q + "#ElasticIpDetails:AllocationId=" + eid;
    default:
      return null;
  }
}

export { awsConsoleUrl, AWS_CONSOLE_HOSTS };
