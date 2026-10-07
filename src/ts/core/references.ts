// core/references.ts — configuration references, resolved to resource addresses through modules

/* The plan's `configuration` is the only place dependencies are recorded
   before apply, and it stays nested: a module's resources use addresses
   relative to the module ("aws_subnet.a"), reference its inputs as var.x, and
   are reached from outside as module.net.<output>. resource_changes, by
   contrast, is flat and fully qualified ("module.net[0].aws_subnet.a[1]").

   This module joins the two. It builds an index of the configuration once,
   then resolves each resource instance's references into the fully qualified
   addresses used everywhere else.

   Resolution is per instance, not per config block: a resource in
   module.net[0] refers to the rest of module.net[0], never module.net[1]. */

export interface ConfigModule {
  resources: any[];
  calls: Record<string, ConfigCall>;
  outputs: Record<string, any>;
}

export interface ConfigCall {
  expressions: Record<string, any>;
  dependsOn: string[];
  module: ConfigModule;
}

export interface ConfigIndex {
  root: ConfigModule;
  /* configuration resource, keyed by its qualified address without instance
     keys: "module.net.aws_subnet.a" */
  byKey: Record<string, any>;
}

var MAX_DEPTH = 12;

/* Split an address on the dots that are not inside an instance key, so
   aws_instance.web["a.b"] stays two segments. */
function splitAddr(addr: string): string[] {
  var out: string[] = [], cur = "", depth = 0, quoted = false;
  for (var i = 0; i < addr.length; i++){
    var c = addr.charAt(i);
    if (quoted){
      cur += c;
      if (c === "\\" && i + 1 < addr.length){ cur += addr.charAt(++i); }
      else if (c === "\"") quoted = false;
      continue;
    }
    if (c === "\"") { quoted = true; cur += c; continue; }
    if (c === "[") depth++;
    if (c === "]") depth--;
    if (c === "." && depth === 0){ out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function stripIndex(seg: string): string {
  var i = seg.indexOf("[");
  return i < 0 ? seg : seg.slice(0, i);
}

/* "module.net[0].aws_subnet.a[1]" -> "module.net.aws_subnet.a" */
function cfgKey(addr: string): string {
  return splitAddr(addr).map(stripIndex).join(".");
}

/* leading module segments ("module.net[0]") and the resource part that follows */
function splitModules(addr: string): { mods: string[]; rest: string } {
  var parts = splitAddr(addr), mods: string[] = [], i = 0;
  while (i + 1 < parts.length && parts[i] === "module"){
    mods.push("module." + parts[i + 1]);
    i += 2;
  }
  return { mods: mods, rest: parts.slice(i).join(".") };
}

/* the module an address lives in: "module.net[0]", or "" at the root */
function moduleOf(addr: string): string {
  return splitModules(addr).mods.join(".");
}

function readModule(m: any): ConfigModule {
  var calls: Record<string, ConfigCall> = {};
  var raw = (m && m.module_calls) || {};
  Object.keys(raw).forEach(function(name: string){
    var c = raw[name] || {};
    calls[name] = {
      expressions: c.expressions || {},
      dependsOn: c.depends_on || [],
      module: readModule(c.module)
    };
  });
  return { resources: (m && m.resources) || [], calls: calls, outputs: (m && m.outputs) || {} };
}

function buildConfigIndex(plan: any): ConfigIndex {
  var root = readModule(plan && plan.configuration && plan.configuration.root_module);
  var byKey: Record<string, any> = {};
  (function walk(m: ConfigModule, prefix: string): void {
    m.resources.forEach(function(r: any){ byKey[prefix + r.address] = r; });
    Object.keys(m.calls).forEach(function(name: string){
      walk(m.calls[name].module, prefix + "module." + name + ".");
    });
  })(root, "");
  return { root: root, byKey: byKey };
}

function nodeAt(idx: ConfigIndex, names: string[]): ConfigCall | null {
  var m = idx.root, call: ConfigCall | null = null;
  for (var i = 0; i < names.length; i++){
    call = m.calls[names[i]] || null;
    if (!call) return null;
    m = call.module;
  }
  return call;
}

/* The reference strings of one configuration block: a top-level argument, or
   an argument of a repeated nested block. */
function rawRefs(expressions: Record<string, any> | undefined): string[] {
  var out: string[] = [];
  var expr = expressions || {};
  Object.keys(expr).forEach(function(k: string){
    var e = expr[k];
    if (e && e.references){ out = out.concat(e.references); return; }
    if (!Array.isArray(e)) return;
    e.forEach(function(item: any){
      if (!item || typeof item !== "object") return;
      Object.keys(item).forEach(function(kk: string){
        if (item[kk] && item[kk].references) out = out.concat(item[kk].references);
      });
    });
  });
  return out;
}

function qualify(inst: string[], addr: string): string {
  return inst.length ? inst.join(".") + "." + addr : addr;
}

/* One reference, seen from inside the module named by `names`, whose actual
   instance path is `inst` (a segment may lack its index when it is not known,
   which expandTargets later widens). Returns qualified addresses. */
function resolveRef(idx: ConfigIndex, ref: any, names: string[], inst: string[], depth: number): string[] {
  if (typeof ref !== "string" || depth > MAX_DEPTH) return [];
  var parts = splitAddr(ref);
  var first = parts[0];

  if (first === "var"){
    if (!names.length || parts.length < 2) return [];
    var call = nodeAt(idx, names);
    var e = call && call.expressions[stripIndex(parts[1])];
    var refs: string[] = (e && e.references) || [];
    return flat(refs.map(function(r: string){
      return resolveRef(idx, r, names.slice(0, -1), inst.slice(0, -1), depth + 1);
    }));
  }

  if (first === "module"){
    if (parts.length < 2) return [];
    var child = stripIndex(parts[1]);
    if (parts.length === 2) return [];      /* the bare module: its outputs are listed too */
    var node = nodeAt(idx, names.concat(child));
    var o = node && node.module.outputs[stripIndex(parts[2])];
    var orefs: string[] = (o && o.expression && o.expression.references) || [];
    var seg = "module." + parts[1];
    return flat(orefs.map(function(r: string){
      return resolveRef(idx, r, names.concat(child), inst.concat(seg), depth + 1);
    }));
  }

  if (/^(local|each|count|path|terraform|data)$/.test(first)) return [];
  if (!isResourceType(first) || parts.length < 2) return [];
  return [qualify(inst, first + "." + parts[1])];
}

/* depends_on entries are addresses, not expressions; a whole module is a
   dependency on everything inside it. */
function resolveDep(idx: ConfigIndex, dep: any, names: string[], inst: string[]): string[] {
  if (typeof dep !== "string") return [];
  var parts = splitAddr(dep);
  if (parts[0] === "module" && parts.length === 2) return [qualify(inst, "module." + parts[1])];
  if (parts[0] === "module") return resolveRef(idx, dep, names, inst, 0);
  if (!isResourceType(parts[0]) || parts.length < 2) return [];
  return [qualify(inst, parts[0] + "." + parts[1])];
}

/* True if word has the form of a resource type, "<provider>_<name>", for
   any provider. The other first segments a Terraform reference can have
   (var, local, module, data, each, count, path, terraform, self) contain no
   underscore, so they do not match. */
function isResourceType(word: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]*_[A-Za-z0-9_-]+$/.test(word);
}

function flat(lists: string[][]): string[] {
  return lists.reduce(function(a: string[], b: string[]){ return a.concat(b); }, []);
}

function segMatches(target: string, actual: string): boolean {
  return target === actual || (target.indexOf("[") < 0 && stripIndex(actual) === target);
}

/* A target whose module path names an instance exactly stays; one that does
   not (a child module reached through an output) widens to every instance
   that exists. A whole-module target becomes every resource inside it. */
function expandTargets(targets: string[], allAddrs: string[]): string[] {
  var mods: Record<string, string[]> = {};
  allAddrs.forEach(function(a: string){ mods[moduleOf(a)] = splitModules(a).mods; });
  var seen: Record<string, boolean> = {}, out: string[] = [];
  function add(a: string){ if (!seen[a]){ seen[a] = true; out.push(a); } }

  targets.forEach(function(t: string){
    var sm = splitModules(t);
    if (!sm.mods.length){ add(t); return; }
    if (sm.rest){
      Object.keys(mods).forEach(function(k: string){
        var m = mods[k];
        if (m.length === sm.mods.length && sm.mods.every(function(s: string, i: number){ return segMatches(s, m[i]); }))
          add(m.join(".") + "." + sm.rest);
      });
      return;
    }
    allAddrs.forEach(function(a: string){
      var m = splitModules(a).mods;
      if (m.length >= sm.mods.length && sm.mods.every(function(s: string, i: number){ return segMatches(s, m[i]); })) add(a);
    });
  });
  return out;
}

/* The resources one resource instance depends on, as qualified addresses. */
function refsFor(idx: ConfigIndex, address: string, allAddrs: string[]): string[] {
  var cfg = idx.byKey[cfgKey(address)];
  if (!cfg) return [];
  var inst = splitModules(address).mods;
  var names = inst.map(function(s: string){ return stripIndex(s).slice("module.".length); });

  var targets: string[] = [];
  rawRefs(cfg.expressions).forEach(function(r: string){
    targets = targets.concat(resolveRef(idx, r, names, inst, 0));
  });
  (cfg.depends_on || []).forEach(function(d: string){
    targets = targets.concat(resolveDep(idx, d, names, inst));
  });
  /* a depends_on on a module call holds for every resource inside it */
  for (var k = 1; k <= names.length; k++){
    var call = nodeAt(idx, names.slice(0, k));
    if (!call) continue;
    call.dependsOn.forEach(function(d: string){
      targets = targets.concat(resolveDep(idx, d, names.slice(0, k - 1), inst.slice(0, k - 1)));
    });
  }
  return expandTargets(targets, allAddrs).filter(function(a: string){ return a !== address; });
}

/* The graph Terraform saved at the last apply: every resource in the plan's
   prior_state lists what it depends on, by full address. Unlike the
   configuration it sees through locals ("local.vpc_id"), which the plan JSON
   cannot otherwise resolve. It only knows resources that already exist, and
   reflects the previous apply, so it adds to the configuration's links and
   never replaces them. */
function readStateGraph(plan: any): Record<string, string[]> {
  var graph: Record<string, string[]> = {};
  var root = plan && plan.prior_state && plan.prior_state.values && plan.prior_state.values.root_module;
  (function walk(m: any): void {
    if (!m) return;
    (m.resources || []).forEach(function(r: any){
      if (r.mode === "data") return;
      graph[r.address] = (r.depends_on || []).filter(function(d: any){ return typeof d === "string"; });
    });
    (m.child_modules || []).forEach(walk);
  })(root);
  return graph;
}

function stripInstance(a: string): string { return a.replace(/\[[^\]]*\]$/, ""); }

/* Add the saved graph's links to each resource's refs, and record which came
   from state alone (stateRefs). A dependency is a bare resource address, so it
   widens to the instances that exist, unless the configuration already named
   that resource (a specific instance, or the same bare form), which would
   only make a single reference look like a splat. */
function addStateEdges(plan: any, resources: any[]): void {
  var graph = readStateGraph(plan);
  var known: Record<string, boolean> = {};
  resources.forEach(function(r: any){ known[r.addr] = true; });
  var addrs = Object.keys(known);

  resources.forEach(function(r: any){
    var deps = graph[r.addr];
    if (!deps || !deps.length) return;
    var added: string[] = [];
    deps.forEach(function(t: string){
      var targets: string[];
      if (known[t]) targets = [t];
      else {
        if (r.refs.some(function(x: string){ return stripInstance(x) === t; })) return;
        targets = addrs.filter(function(a: string){ return a.indexOf(t + "[") === 0; });
      }
      targets.forEach(function(a: string){
        if (a !== r.addr && r.refs.indexOf(a) < 0){ r.refs.push(a); added.push(a); }
      });
    });
    if (added.length) r.stateRefs = added;
  });
}

/* A dependency list as a person should see it. Terraform lists a referenced
   object at several levels ("aws_x.y[0]" and the bare "aws_x.y" together), and
   a reference can name something the plan has no instance of. So: a bare base
   is dropped when its specific form is already listed, otherwise it expands to
   the instances that exist, and what is not in the plan is kept but marked, so
   it is not offered as a link that goes nowhere. */
export interface RefRow { addr: string; inPlan: boolean; }

function listRefs(refs: string[], known: Record<string, any>): RefRow[] {
  var out: RefRow[] = [], seen: Record<string, boolean> = {};
  function add(a: string, inPlan: boolean){ if (!seen[a]){ seen[a] = true; out.push({ addr: a, inPlan: inPlan }); } }
  var specific: Record<string, boolean> = {};
  refs.forEach(function(r: string){
    if (/\[[^\]]*\]$/.test(r)) specific[r.replace(/\[[^\]]*\]$/, "")] = true;
  });
  refs.forEach(function(r: string){
    if (known[r]){ add(r, true); return; }
    if (specific[r]) return;
    var inst = Object.keys(known).filter(function(k: string){ return k.indexOf(r + "[") === 0; });
    if (inst.length){ inst.forEach(function(k: string){ add(k, true); }); return; }
    add(r, false);
  });
  return out;
}

export { splitAddr, cfgKey, splitModules, moduleOf, buildConfigIndex, refsFor, addStateEdges, listRefs };
