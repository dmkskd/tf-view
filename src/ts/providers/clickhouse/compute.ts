// providers/clickhouse/compute.ts — a service's compute, from its plan values
//
// Replicas come from num_replicas (vertical) or min_replicas–max_replicas
// (horizontal); memory per replica from min_ and max_replica_memory_gb.
// vCPU follows from memory: 4 GiB per vCPU in the default profile, 8 in the
// high-memory one (ClickHouse Cloud docs, "Cloud tiers").
import { ProviderResource, asText } from "../../sdk/index.js";

type Range = [number, number];

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
}

function pair(lo: number | null, hi: number | null): Range | null {
  if (lo === null && hi === null) return null;
  return [lo === null ? hi! : lo, hi === null ? lo! : hi];
}

/* "8" or "8–32"; whole numbers, else one decimal */
export function rangeText(r: Range): string {
  var f = function(n: number){ return Math.round(n) === n ? String(n) : n.toFixed(1); };
  return r[0] === r[1] ? f(r[0]) : f(r[0]) + "–" + f(r[1]);
}

/* GiB of memory per vCPU, or null for a profile whose ratio is not known */
function gibPerVcpu(r: ProviderResource): number | null {
  var p = asText(r.attrs.profile).toLowerCase();
  if (!p || p.indexOf("default") >= 0) return 4;
  if (p.indexOf("highmem") >= 0 || p.indexOf("high-mem") >= 0) return 8;
  return null;
}

export interface Compute {
  replicas: Range | null;     /* null when the plan does not know the count */
  horizontal: boolean;        /* the count is a min_replicas–max_replicas band */
  memory: Range | null;       /* GiB per replica */
  vcpu: Range | null;         /* vCPU per replica */
}

export function serviceCompute(r: ProviderResource): Compute {
  var a = r.attrs;
  var n = num(a.num_replicas);
  var replicas = n !== null ? [n, n] as Range : pair(num(a.min_replicas), num(a.max_replicas));
  var memory = pair(num(a.min_replica_memory_gb), num(a.max_replica_memory_gb));
  var ratio = gibPerVcpu(r);
  var vcpu = memory && ratio ? [memory[0] / ratio, memory[1] / ratio] as Range : null;
  return { replicas: replicas, horizontal: n === null && !!replicas, memory: memory, vcpu: vcpu };
}

/* lowest × lowest – highest × highest */
export function total(count: Range, each: Range): Range {
  return [count[0] * each[0], count[1] * each[1]];
}

/* ha_type as standbys: "none" has none, "async" one asynchronous standby,
   "sync" two synchronous ones (ClickHouse Managed Postgres docs, "High
   availability"). Empty when the plan does not say. */
export function pgStandbys(r: ProviderResource): string {
  var ha = asText(r.attrs.ha_type);
  if (ha === "none") return "no standby";
  if (ha === "async") return "1 async standby";
  if (ha === "sync") return "2 sync standbys";
  return ha;
}
