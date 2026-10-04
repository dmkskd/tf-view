// core/snapshot.ts — the parsed model as plain data, for inspection and export
import { PlanModel, PlanResource } from "../types/index.js";

/* What the viewer understood from the input, with none of the input's bulk.
   Attribute values are left out unless asked for: they can hold secrets, and
   the point of a snapshot is to see how things were resolved (module, action,
   links and where each link came from), not to copy the plan again. */
function modelSnapshot(model: PlanModel, withAttrs?: boolean): any {
  var plain = function(s: string): string { return String(s || "").replace(/<[^>]+>/g, ""); };
  return {
    source: model.source,
    terraform: model.tfVersion,
    region: model.region || null,
    summary: model.summary,
    variables: Object.keys(model.variables || {}).sort(),
    outputs: model.outputs
      ? Object.keys(model.outputs).sort().map(function(n: string){
          return { name: n, actions: model.outputs![n].actions };
        })
      : [],
    drift: model.drift || [],
    diagnostics: (model.diagnostics || []).map(function(d: any){
      return { level: d.level, code: d.code, message: plain(d.msg), detail: d.detail || undefined };
    }),
    resources: model.resources.map(function(r: PlanResource){
      var o: any = {
        addr: r.addr,
        type: r.type,
        module: r.module || "",
        action: r.action,
        kind: r.kind,
        supported: !!r.supported,
        refs: r.refs,
        stateRefs: r.stateRefs || [],
        dependents: r.dependents || []
      };
      if (r.replacePaths && r.replacePaths.length) o.replacePaths = r.replacePaths;
      if (withAttrs) o.attrs = r.attrs;
      return o;
    })
  };
}

export { modelSnapshot };
