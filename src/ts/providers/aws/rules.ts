// providers/aws/rules.ts — AWS Security Group and Network ACL rules
import { ProviderResource, RuleDescription, RuleListSpec, JsonValue, asList, valueAt } from "../../sdk/index.js";

/* one ingress/egress entry of a security group or network ACL */
interface AwsRuleEntry {
  protocol?: string | number;
  from_port?: number;
  to_port?: number;
  cidr_blocks?: string[];
  ipv6_cidr_blocks?: string[];
  prefix_list_ids?: string[];
  security_groups?: string[];
  self?: boolean;
  cidr_block?: string;
  ipv6_cidr_block?: string;
  rule_no?: number;
  action?: string;
  description?: string;
}

/* Converts a plan value to an AwsRuleEntry, keeping only the fields this file
   reads, and each only if it has the expected type. */
function toRuleEntry(v: JsonValue): AwsRuleEntry {
  var own = function(k: string): JsonValue | undefined { return Array.isArray(v) ? undefined : valueAt(v, k); };
  var num = function(k: string): number | undefined { var x = own(k); return typeof x === "number" ? x : undefined; };
  var str = function(k: string): string | undefined { var x = own(k); return typeof x === "string" ? x : undefined; };
  var strs = function(k: string): string[] {
    return asList(own(k)).filter(function(x: JsonValue){ return typeof x === "string"; }) as string[];
  };
  var proto = own("protocol");
  return {
    protocol: typeof proto === "string" || typeof proto === "number" ? proto : undefined,
    from_port: num("from_port"), to_port: num("to_port"),
    cidr_blocks: strs("cidr_blocks"), ipv6_cidr_blocks: strs("ipv6_cidr_blocks"),
    prefix_list_ids: strs("prefix_list_ids"), security_groups: strs("security_groups"),
    self: own("self") === true,
    cidr_block: str("cidr_block"), ipv6_cidr_block: str("ipv6_cidr_block"),
    rule_no: num("rule_no"), action: str("action"), description: str("description")
  };
}

var PORT_NAME: Record<number, string> = {
  20:"ftp-data", 21:"ftp", 22:"ssh", 23:"telnet", 25:"smtp", 53:"dns",
  67:"dhcp", 68:"dhcp", 80:"http", 110:"pop3", 111:"rpc", 123:"ntp",
  135:"rpc", 139:"netbios", 143:"imap", 161:"snmp", 389:"ldap", 443:"https",
  445:"smb", 465:"smtps", 514:"syslog", 587:"smtp", 636:"ldaps", 873:"rsync",
  993:"imaps", 995:"pop3s", 1194:"openvpn", 1433:"mssql", 1521:"oracle",
  2049:"nfs", 2375:"docker", 2376:"docker-tls", 3000:"grafana", 3306:"mysql",
  3389:"rdp", 4369:"epmd", 5000:"flask", 5432:"postgres", 5601:"kibana",
  5672:"amqp", 6379:"redis", 8000:"http-alt", 8080:"http-alt", 8443:"https-alt",
  8500:"consul", 9042:"cassandra", 9092:"kafka", 9200:"elasticsearch",
  9300:"elasticsearch", 11211:"memcached", 15672:"rabbitmq", 27017:"mongodb"
};

function portName(e: AwsRuleEntry): string {
  if (e.protocol === "-1" || e.protocol === "all") return "";
  if (e.from_port !== undefined && e.from_port === e.to_port) return PORT_NAME[e.from_port] || "";
  if (e.from_port === 1024 && e.to_port === 65535) return "ephemeral";
  if (e.from_port === 32768 && e.to_port === 65535) return "ephemeral";
  if (e.from_port === 0 && e.to_port === 65535) return "all ports";
  return "";
}

function portText(r: AwsRuleEntry): string {
  if (r.protocol === "-1" || r.protocol === "all") return "all";
  if (r.from_port === 0 && r.to_port === 0) return "all";
  if (r.from_port !== undefined && r.from_port === r.to_port) return String(r.from_port);
  return r.from_port + "\u2013" + r.to_port;
}
function protoText(p?: string | number | null): string {
  if (p === "-1" || p === undefined || p === null) return "all";
  return String(p);
}
function peerText(e: AwsRuleEntry): string {
  var out: string[] = [];
  (e.cidr_blocks || []).forEach(function(c: string){ out.push(c); });
  (e.ipv6_cidr_blocks || []).forEach(function(c: string){ out.push(c); });
  (e.prefix_list_ids || []).forEach(function(c: string){ out.push("pl " + c); });
  (e.security_groups || []).forEach(function(c: string){ out.push("sg " + c); });
  if (e.self) out.push("self");
  if (e.cidr_block) out.push(e.cidr_block);
  if (e.ipv6_cidr_block) out.push(e.ipv6_cidr_block);
  return out.length ? out.join(", ") : "\u2014";
}

var DIRECTIONS = [
  {attr: "ingress", inbound: true,  peerHeading: "Source"},
  {attr: "egress",  inbound: false, peerHeading: "Destination"}
];

var SG_RULES: RuleListSpec = {
  title: "Security group rules", name: "security group", ordered: false,
  note: "Stateful: replies to allowed traffic return without a matching rule.",
  directions: DIRECTIONS
};

var NACL_RULES: RuleListSpec = {
  title: "Network ACL rules", name: "network acl", ordered: true,
  note: "Stateless: each direction is evaluated independently, first match wins.",
  directions: DIRECTIONS,
  implicit: {number: "*", ports: "all", protocol: "all", service: "", peer: "0.0.0.0/0", action: "deny"}
};

function awsRuleSet(r: ProviderResource): RuleListSpec | null {
  if (r.type === "aws_security_group") return SG_RULES;
  if (r.type === "aws_network_acl") return NACL_RULES;
  return null;
}

function awsDescribeRule(v: JsonValue): RuleDescription {
  var e = toRuleEntry(v);
  return {
    ports: portText(e),
    service: portName(e),
    protocol: protoText(e.protocol),
    peer: peerText(e),
    number: e.rule_no != null ? String(e.rule_no) : null,
    order: e.rule_no || 0,
    action: e.action != null ? String(e.action) : null,
    description: e.description ? String(e.description) : null
  };
}

function awsRuleKey(v: JsonValue): string {
  var e = toRuleEntry(v);
  return [e.action || "", e.protocol, e.from_port, e.to_port,
          peerText(e), e.rule_no == null ? "" : e.rule_no].join("|");
}

export {
  PORT_NAME, portName, portText, protoText, peerText,
  awsRuleSet, awsDescribeRule, awsRuleKey
};
