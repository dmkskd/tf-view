// providers/clickhouse/index.ts — ClickHouse Cloud provider
//
// Services, their private endpoints, ClickPipes, schedules and queries, and
// organization resources (API keys, roles). A service runs in a cloud and
// region of its own (`cloud_provider`, `region`); the provider block sets no
// region.
import {
  ProviderPlugin, CatalogEntry, ProviderResource, RuleListSpec, RuleDescription, SummaryRow,
  JsonValue, IconDefinition, asText, valueAt
} from "../../sdk/index.js";
import { startClickHousePlacement } from "./placement.js";
import { serviceCompute, rangeText, total, pgStandbys } from "./compute.js";

export var CH_REG: Record<string, CatalogEntry> = {
  clickhouse_service:                              {kind:"group", label:"ClickHouse Service",  icon:"database",     cat:"db",
                                                     preview:["cloud_provider","region","idle_scaling","idle_timeout_minutes"]},
  clickhouse_postgres_service:                     {kind:"node",  label:"Postgres Service",    icon:"database",     cat:"db", sub:"size",
                                                     preview:["cloud_provider","region","hostname"]},
  clickhouse_service_private_endpoints_attachment: {kind:"node",  label:"Private Endpoints",   icon:"i-vpce",   cat:"net",
                                                     preview:["private_endpoint_ids"]},
  clickhouse_private_endpoint_registration:        {kind:"node",  label:"Endpoint Registration", icon:"i-vpce", cat:"net", sub:"cloud_provider",
                                                     preview:["private_endpoint_id","cloud_provider","region"]},
  clickhouse_clickpipes_reverse_private_endpoint:  {kind:"node",  label:"Reverse Endpoint",    icon:"i-vpce",   cat:"net", sub:"type",
                                                     preview:["type","vpc_endpoint_service_name","msk_cluster_arn","vpc_resource_configuration_id"]},
  clickhouse_clickpipes_reverse_private_endpoint_custom_private_dns:
                                                   {kind:"node",  label:"Reverse Endpoint DNS", icon:"i-r53",   cat:"net"},
  clickhouse_clickpipe:                            {kind:"node",  label:"ClickPipe",           icon:"pipe",     cat:"integ", sub:"source",
                                                     preview:["name","stopped"]},
  clickhouse_clickpipe_cdc_infrastructure:         {kind:"node",  label:"CDC Infrastructure",  icon:"chip",     cat:"integ", sub:"replica_memory_gb",
                                                     preview:["replica_cpu_millicores","replica_memory_gb"]},
  clickhouse_clickpipes_ssh_key:                   {kind:"node",  label:"ClickPipes SSH Key",  icon:"i-kms",    cat:"sec"},
  clickhouse_service_upgrade_window:               {kind:"node",  label:"Upgrade Window",      icon:"clock",    cat:"mgmt",
                                                     preview:["weekday","start_hour_utc"]},
  clickhouse_service_scheduled_scaling:            {kind:"node",  label:"Scheduled Scaling",   icon:"clock",    cat:"mgmt",
                                                     preview:["entries"]},
  clickhouse_service_transparent_data_encryption_key_association:
                                                   {kind:"node",  label:"TDE Key",             icon:"i-kms",    cat:"sec"},
  clickhouse_query_api_endpoint:                   {kind:"node",  label:"Query API Endpoint",  icon:"query",    cat:"integ",
                                                     preview:["name","database","roles"]},
  clickhouse_saved_query:                          {kind:"node",  label:"Saved Query",         icon:"query",    cat:"mgmt",
                                                     preview:["name","database"]},
  clickhouse_udf:                                  {kind:"node",  label:"UDF",                 icon:"i-lambda", cat:"compute"},
  clickhouse_udf_attachment:                       {kind:"assoc", label:"UDF Attachment",      icon:"i-lambda", cat:"compute"},
  clickhouse_byoc_infrastructure:                  {kind:"node",  label:"BYOC Infrastructure", icon:"i-cloud",  cat:"net", scope:"region"},
  clickhouse_api_key:                              {kind:"node",  label:"API Key",             icon:"i-iam",    cat:"sec", scope:"global",
                                                     preview:["name","state","expire_at"]},
  clickhouse_role:                                 {kind:"node",  label:"Role",                icon:"i-iam",    cat:"sec", scope:"global",
                                                     preview:["name"]},
  clickhouse_role_assignment:                      {kind:"assoc", label:"Role Assignment",     icon:"i-iam",    cat:"sec", scope:"global",
                                                     preview:["role_id","api_key_ids","user_ids"]},
  clickhouse_organization_settings:                {kind:"node",  label:"Organization Settings", icon:"i-cw",   cat:"mgmt", scope:"global",
                                                     preview:["core_dumps_enabled"]}
};

var ICONS: Record<string, IconDefinition> = {
  /* a database cylinder: a top cap and two bands */
  database: { paths: ["M13 15 A11 4 0 1 0 35 15 A11 4 0 1 0 13 15 Z",
                      "M13 17.5 A11 4 0 0 0 35 17.5 V24 A11 4 0 0 1 13 24 Z",
                      "M13 26.5 A11 4 0 0 0 35 26.5 V33 A11 4 0 0 1 13 33 Z"] },
  /* an arrow: data moving into the service */
  pipe:  { paths: ["M8 20 H27 V12 L40 24 L27 36 V28 H8 Z"] },
  /* a chip: compute (the CDC workers that run a service's DB ClickPipes) */
  chip:  { paths: ["M14 14 H34 V34 H14 Z M18 18 V30 H30 V18 Z",
                   "M18 8 H21 V14 H18 Z M27 8 H30 V14 H27 Z M18 34 H21 V40 H18 Z M27 34 H30 V40 H27 Z",
                   "M8 18 H14 V21 H8 Z M8 27 H14 V30 H8 Z M34 18 H40 V21 H34 Z M34 27 H40 V30 H34 Z"] },
  /* a clock face with hands */
  clock: { paths: ["M24 8 A16 16 0 1 1 23.99 8 Z M24 12 A12 12 0 1 0 24.01 12 Z",
                   "M22.5 14 H25.5 V22.5 H32 V25.5 H22.5 Z"] },
  /* a magnifier */
  query: { paths: ["M20 8 A12 12 0 1 1 19.99 8 Z M20 12 A8 8 0 1 0 20.01 12 Z",
                   "M27.5 30.5 L30.5 27.5 L40 37 L37 40 Z"] }
};

/* The source a ClickPipe reads from: the one key of `source` that is set. */
function pipeSource(r: ProviderResource): string {
  var src = r.attrs.source;
  if (!src || typeof src !== "object" || Array.isArray(src)) return "";
  var keys = Object.keys(src).filter(function(k: string){ return valueAt(src, k) != null; });
  if (keys.length !== 1) return "";
  var kind = keys[0];
  var type = asText(valueAt(src, kind, "type"));
  return kind === "object_storage" && type ? type : kind.replace(/_/g, " ");
}

/* "1 vCPU · 4 GiB": the size of each CDC worker replica */
function cdcSize(r: ProviderResource): string {
  var cpu = r.attrs.replica_cpu_millicores, mem = r.attrs.replica_memory_gb;
  var out: string[] = [];
  if (typeof cpu === "number") out.push(cpu / 1000 + " vCPU");
  if (typeof mem === "number") out.push(mem + " GiB");
  return out.join(" \u00b7 ");
}

/* "m6gd.large · PG 18 · HA": size, major version, and HA when it has standbys */
function pgTile(r: ProviderResource): string {
  var out: string[] = [];
  var size = asText(r.attrs.size), version = asText(r.attrs.postgres_version), ha = asText(r.attrs.ha_type);
  if (size) out.push(size);
  if (version) out.push("PG " + version);
  if (asText(r.attrs.read_replica_of)) out.push("replica");
  else if (ha && ha !== "none") out.push("HA " + ha);
  return out.join(" \u00b7 ");
}

/* ip_access: the addresses allowed to connect to a service's public endpoint,
   or to use an API key. Everything else is refused. */
var IP_ACCESS: RuleListSpec = {
  title: "IP access list", name: "ip access list", ordered: false,
  note: "Only the listed sources can connect. An empty list allows no public access; " +
        "connections through a private endpoint are allowed by the endpoint attachment.",
  directions: [{attr: "ip_access", inbound: true, peerHeading: "Source"}],
  implicit: {ports: "all", protocol: "all", service: "", peer: "any other source", description: "refused"}
};

/* A service's compute: replicas, memory and vCPU per replica, and the total
   across replicas. */
function chSummary(r: ProviderResource): SummaryRow[] {
  if (r.type === "clickhouse_postgres_service") return pgSummary(r);
  if (r.type !== "clickhouse_service") return [];
  var c = serviceCompute(r);
  var rows: SummaryRow[] = [];
  rows.push({ label: "replicas", value: c.replicas
    ? rangeText(c.replicas) + (c.horizontal ? " (horizontal autoscaling)" : "")
    : "not in the plan" });
  if (c.memory){
    rows.push({ label: "per replica", value: rangeText(c.memory) + " GiB" + (c.vcpu ? " \u00b7 " + rangeText(c.vcpu) + " vCPU" : "") });
    if (c.replicas){
      rows.push({ label: "total", value: rangeText(total(c.replicas, c.memory)) + " GiB" +
        (c.vcpu ? " \u00b7 " + rangeText(total(c.replicas, c.vcpu)) + " vCPU" : "") });
    }
  }
  return rows;
}

/* A Postgres service: instance size, major version, standbys. */
function pgSummary(r: ProviderResource): SummaryRow[] {
  var rows: SummaryRow[] = [];
  var size = asText(r.attrs.size), version = asText(r.attrs.postgres_version);
  if (size) rows.push({ label: "size", value: size });
  if (version) rows.push({ label: "postgres", value: version });
  var ha = pgStandbys(r);
  if (ha) rows.push({ label: "high availability", value: ha });
  if (asText(r.attrs.read_replica_of)) rows.push({ label: "role", value: "read replica" });
  return rows;
}

function chRuleSet(r: ProviderResource): RuleListSpec | null {
  return r.type === "clickhouse_service" || r.type === "clickhouse_api_key" ? IP_ACCESS : null;
}

function chDescribeRule(v: JsonValue): RuleDescription {
  var source = asText(valueAt(v, "source"));
  return {
    ports: "all",
    service: "",
    protocol: "all",
    peer: source === "0.0.0.0/0" ? "0.0.0.0/0 (anywhere)" : (source || "—"),
    description: asText(valueAt(v, "description")) || null
  };
}

function chRuleKey(v: JsonValue): string {
  return asText(valueAt(v, "source"));
}

export const clickhouseProvider: ProviderPlugin = {
  id: "clickhouse",
  name: "ClickHouse Cloud",
  sourceAddresses: ["registry.terraform.io/clickhouse/clickhouse", "registry.opentofu.org/clickhouse/clickhouse"],
  localNames: ["clickhouse"],
  typePrefix: "clickhouse_",
  cloudLabel: "ClickHouse Cloud",
  regionNote: "per service",
  globalNote: "organization",
  unplacedNote: "no service reference",
  settingKeys: ["organization_id"],
  icons: ICONS,
  catalog: CH_REG,
  categories: {
    compute: "var(--cat-compute)",
    net:     "var(--cat-net)",
    sec:     "var(--cat-sec)",
    db:      "var(--cat-db)",
    mgmt:    "var(--cat-mgmt)",
    integ:   "var(--cat-integ)"
  },
  categoryLabels: [
    ["db",      "Services"],
    ["net",     "Private endpoints"],
    ["integ",   "ClickPipes and query endpoints"],
    ["sec",     "Access"],
    ["mgmt",    "Management"],
    ["compute", "Functions"]
  ],
  /* ClickHouse Cloud has an HTTP API and no read-only CLI */
  cli: function(){ return []; },
  summary: chSummary,
  tileSubtitle: function(r: ProviderResource, value: string): string {
    if (r.type === "clickhouse_clickpipe") return pipeSource(r);
    if (r.type === "clickhouse_clickpipe_cdc_infrastructure") return cdcSize(r);
    if (r.type === "clickhouse_postgres_service") return pgTile(r);
    return value;
  },
  rules: {
    ruleSet: chRuleSet,
    describe: chDescribeRule,
    key: chRuleKey
  },
  placement: { start: startClickHousePlacement }
};

export default clickhouseProvider;
