// providers/aws/cli.ts — AWS CLI recipes
import { ProviderResource, ProviderCommand, ProviderSettings, asText, valueAt } from "../../sdk/index.js";

/* ---- AWS CLI: read-only inspection commands per resource type. IDs are
   unknown at plan time, so commands filter by Name tag or name_prefix where
   possible, and use placeholders such as <vpc-id> otherwise. Each command is
   an argument list; core/shell.ts quotes it, so plan values are passed
   unmodified and this file does no shell quoting. ---- */

/* A JMESPath raw string literal ('...', with \ and ' escaped). This is
   quoting for the --query language, inside one argument, not shell quoting. */
function jmesLiteral(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

function awsCommands(r: ProviderResource, settings: Readonly<ProviderSettings>): ProviderCommand[] {
  var reg: string[] = settings.region ? ["--region", settings.region] : [];
  var attrs = r.attrs;
  var tag = asText(valueAt(attrs, "tags", "Name"));
  var byTag: string[] = tag ? ["--filters", "Name=tag:Name,Values=" + tag] : [];
  var pfx = asText(attrs.name_prefix);
  var t = r.type;
  var L: ProviderCommand[] = [];
  function add(label: string, argv: string[]): void { L.push({label: label, argv: argv}); }
  function aws(service: string, op: string): string[] { return ["aws", service, op]; }
  function val(k: string, fallback: string): string { return asText(attrs[k]) || fallback; }
  function opt(flag: string, k: string): string[] { return asText(attrs[k]) ? [flag, asText(attrs[k])] : []; }

  switch (t){
    case "aws_vpc":
      add("Describe", aws("ec2", "describe-vpcs").concat(reg, byTag));
      add("What is in it", aws("ec2", "describe-subnets").concat(reg, ["--filters", "Name=vpc-id,Values=<vpc-id>"]));
      break;
    case "aws_subnet":
      add("Describe", aws("ec2", "describe-subnets").concat(reg, byTag));
      add("Effective network ACL", aws("ec2", "describe-network-acls").concat(reg,
          ["--filters", "Name=association.subnet-id,Values=<subnet-id>", "--query", "NetworkAcls[0].Entries", "--output", "table"]));
      add("Effective route table", aws("ec2", "describe-route-tables").concat(reg,
          ["--filters", "Name=association.subnet-id,Values=<subnet-id>", "--query", "RouteTables[0].Routes", "--output", "table"]));
      break;
    case "aws_instance":
      add("Describe", aws("ec2", "describe-instances").concat(reg, byTag,
          ["--query", "Reservations[].Instances[].{Id:InstanceId,State:State.Name,Private:PrivateIpAddress,Public:PublicIpAddress}", "--output", "table"]));
      add("Open a shell", aws("ssm", "start-session").concat(reg, ["--target", "<instance-id>"]));
      add("Console output", aws("ec2", "get-console-output").concat(reg, ["--instance-id", "<instance-id>", "--output", "text"]));
      break;
    case "aws_security_group":
      add("Describe", aws("ec2", "describe-security-groups").concat(reg, byTag));
      if (pfx) add("Find by prefix", aws("ec2", "describe-security-groups").concat(reg,
          ["--query", "SecurityGroups[?starts_with(GroupName, " + jmesLiteral(pfx) + ")].{Id:GroupId,Name:GroupName}", "--output", "table"]));
      add("Inbound rules", aws("ec2", "describe-security-groups").concat(reg,
          ["--group-ids", "<sg-id>", "--query", "SecurityGroups[0].IpPermissions", "--output", "json"]));
      add("Outbound rules", aws("ec2", "describe-security-groups").concat(reg,
          ["--group-ids", "<sg-id>", "--query", "SecurityGroups[0].IpPermissionsEgress", "--output", "json"]));
      break;
    case "aws_network_acl":
      add("Describe", aws("ec2", "describe-network-acls").concat(reg, byTag));
      add("Rules as a table", aws("ec2", "describe-network-acls").concat(reg,
          ["--network-acl-ids", "<acl-id>", "--query", "NetworkAcls[0].Entries", "--output", "table"]));
      break;
    case "aws_route_table":
      add("Describe", aws("ec2", "describe-route-tables").concat(reg, byTag));
      add("Routes", aws("ec2", "describe-route-tables").concat(reg,
          ["--route-table-ids", "<rtb-id>", "--query", "RouteTables[0].Routes", "--output", "table"]));
      break;
    case "aws_internet_gateway":
    case "aws_egress_only_internet_gateway":
      add("Describe", aws("ec2", "describe-internet-gateways").concat(reg, byTag));
      break;
    case "aws_nat_gateway":
      add("Describe", aws("ec2", "describe-nat-gateways").concat(reg,
          tag ? ["--filter", "Name=tag:Name,Values=" + tag] : []));
      break;
    case "aws_vpc_endpoint":
      add("Describe", aws("ec2", "describe-vpc-endpoints").concat(reg,
          ["--filters", "Name=service-name,Values=" + val("service_name", "<service>")]));
      add("Endpoint ENI addresses", aws("ec2", "describe-network-interfaces").concat(reg,
          ["--filters", "Name=description,Values=*<vpce-id>*", "--query", "NetworkInterfaces[].PrivateIpAddress"]));
      break;
    case "aws_eip":
      add("Describe", aws("ec2", "describe-addresses").concat(reg, byTag));
      break;
    case "aws_iam_role":
      if (pfx) add("Find by prefix", aws("iam", "list-roles").concat(reg,
          ["--query", "Roles[?starts_with(RoleName, " + jmesLiteral(pfx) + ")].RoleName", "--output", "table"]));
      add("Describe", aws("iam", "get-role").concat(["--role-name", "<role-name>"]));
      add("Attached policies", aws("iam", "list-attached-role-policies").concat(["--role-name", "<role-name>", "--output", "table"]));
      break;
    case "aws_iam_instance_profile":
      if (pfx) add("Find by prefix", aws("iam", "list-instance-profiles").concat(
          ["--query", "InstanceProfiles[?starts_with(InstanceProfileName, " + jmesLiteral(pfx) + ")].InstanceProfileName", "--output", "table"]));
      add("Describe", aws("iam", "get-instance-profile").concat(["--instance-profile-name", "<profile-name>"]));
      break;
    case "aws_iam_role_policy_attachment":
      add("Attached policies", aws("iam", "list-attached-role-policies").concat(["--role-name", "<role-name>", "--output", "table"]));
      break;
    case "aws_iam_policy":
      add("Describe", aws("iam", "get-policy").concat(["--policy-arn", "<policy-arn>"]));
      break;
    case "aws_route_table_association":
    case "aws_main_route_table_association":
      add("Associations", aws("ec2", "describe-route-tables").concat(reg,
          ["--query", "RouteTables[].Associations", "--output", "table"]));
      break;
    case "aws_lb":
    case "aws_alb":
      add("Describe", aws("elbv2", "describe-load-balancers").concat(reg, opt("--names", "name")));
      break;
    case "aws_lb_target_group":
      add("Describe", aws("elbv2", "describe-target-groups").concat(reg, opt("--names", "name")));
      add("Target health", aws("elbv2", "describe-target-health").concat(reg, ["--target-group-arn", "<tg-arn>", "--output", "table"]));
      break;
    case "aws_db_instance":
      add("Describe", aws("rds", "describe-db-instances").concat(reg, opt("--db-instance-identifier", "identifier")));
      break;
    case "aws_rds_cluster":
      add("Describe", aws("rds", "describe-db-clusters").concat(reg, opt("--db-cluster-identifier", "cluster_identifier")));
      break;
    case "aws_s3_bucket":
      add("Describe", aws("s3api", "get-bucket-location").concat(["--bucket", val("bucket", "<bucket>")]));
      add("List contents", ["aws", "s3", "ls", "s3://" + val("bucket", "<bucket>") + "/"]);
      break;
    case "aws_lambda_function":
      add("Describe", aws("lambda", "get-function").concat(reg, ["--function-name", val("function_name", "<function>")]));
      add("Recent logs", aws("logs", "tail").concat(reg, ["/aws/lambda/" + val("function_name", "<function>"), "--since", "15m"]));
      break;
    case "aws_cloudwatch_log_group":
      add("Tail", aws("logs", "tail").concat(reg, [val("name", "<log-group>"), "--follow"]));
      break;
    case "aws_eks_cluster":
      add("Describe cluster", aws("eks", "describe-cluster").concat(reg, ["--name", val("name", r.name || "<cluster-name>")]));
      add("Update kubeconfig", aws("eks", "update-kubeconfig").concat(reg, ["--name", val("name", r.name || "<cluster-name>")]));
      break;
    case "aws_eks_node_group":
      add("Describe nodegroup", aws("eks", "describe-nodegroup").concat(reg,
          ["--cluster-name", "<cluster-name>", "--nodegroup-name", val("node_group_name", r.name || "<nodegroup>")]));
      break;
    case "aws_ec2_transit_gateway":
      add("Describe", aws("ec2", "describe-transit-gateways").concat(reg, byTag));
      add("Attachments", aws("ec2", "describe-transit-gateway-attachments").concat(reg, ["--filters", "Name=transit-gateway-id,Values=<tgw-id>"]));
      break;
    case "aws_ec2_transit_gateway_vpc_attachment":
      add("Describe", aws("ec2", "describe-transit-gateway-vpc-attachments").concat(reg, byTag));
      break;
    case "aws_vpc_peering_connection":
      add("Describe", aws("ec2", "describe-vpc-peering-connections").concat(reg, byTag));
      break;
    case "aws_ec2_managed_prefix_list":
      add("Describe", aws("ec2", "describe-managed-prefix-lists").concat(reg, byTag));
      add("Entries", aws("ec2", "get-managed-prefix-list-entries").concat(reg, ["--prefix-list-id", "<prefix-list-id>"]));
      break;
    case "aws_route53_zone":
      add("Get zone", aws("route53", "get-hosted-zone").concat(["--id", "<zone-id>"]));
      add("List records", aws("route53", "list-resource-record-sets").concat(["--hosted-zone-id", "<zone-id>"]));
      break;
    case "aws_route53_record":
      add("List records", aws("route53", "list-resource-record-sets").concat(["--hosted-zone-id", "<zone-id>"]));
      break;
    case "aws_kms_key":
      add("Describe key", aws("kms", "describe-key").concat(reg, ["--key-id", "<key-id>"]));
      add("Key policy", aws("kms", "get-key-policy").concat(reg, ["--key-id", "<key-id>", "--policy-name", "default"]));
      break;
    case "aws_s3_object":
      add("Head object", aws("s3api", "head-object").concat(["--bucket", val("bucket", "<bucket>"), "--key", val("key", "<key>")]));
      break;
    case "aws_lb_target_group_attachment":
      add("Target health", aws("elbv2", "describe-target-health").concat(reg, ["--target-group-arn", "<tg-arn>"]));
      break;
    default:
      if (tag) add("Find by tag", aws("resourcegroupstaggingapi", "get-resources").concat(reg,
          ["--tag-filters", "Key=Name,Values=" + tag]));
      break;
  }
  return L;
}

export { awsCommands, jmesLiteral };
