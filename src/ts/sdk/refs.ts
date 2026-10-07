// sdk/refs.ts — finds the map entries a resource's references point at
//
// A provider's placement typically keeps a map from a resource address to the
// box it created for that resource. r.refs lists the addresses a resource
// references. These functions look references up in such a map, accounting
// for the ways Terraform writes references, described below.
//
// A splat reference (<type>.private[*].id) collapses to the base
// address ("<type>.private") with no [N] — but the group map is keyed
// per-instance ("<type>.private[0]"). Match every instance sharing that
// base address, not just the first: a resource that genuinely spans more
// than one (a load balancer across two subnets, say) has no single
// correct subnet to sit in, and should say so rather than pick one
// arbitrarily — the caller nests it only when exactly one match is found.
//
// Terraform's own references list is not this clean, though: a single,
// specific reference like <type>.public[0].id comes with the base
// address ("<type>.public") ALSO listed alongside the specific one
// ("<type>.public[0]") in the same references array — not because it
// spans every instance, just because Terraform lists a referenced object at
// several levels of specificity. Treating that bare base form as a genuine
// splat would make an ordinary single-instance reference look ambiguous
// across every instance sharing its base address. So: a specific reference
// always wins, and its base form is ignored as the redundant, coarser
// mention it is — only a base address with no accompanying specific one is
// treated as a real splat.

/* Every value in map that refs point at, each once, in first-seen order. */
export function referencedValues<T>(map: Readonly<Record<string, T>>, refs: ReadonlyArray<string>): T[] {
  var found: T[] = [];
  var own = function(k: string): boolean { return Object.prototype.hasOwnProperty.call(map, k); };
  function add(g: T){ if (found.indexOf(g) < 0) found.push(g); }
  var specificBases: Record<string, boolean> = Object.create(null);
  refs.forEach(function(ref: string){
    if (own(ref) && /\[[^\]]*\]$/.test(ref)) specificBases[ref.replace(/\[[^\]]*\]$/, "")] = true;
  });
  refs.forEach(function(ref: string){
    if (own(ref)){ add(map[ref]); return; }
    if (specificBases[ref]) return;
    var prefix = ref + "[";
    Object.keys(map).forEach(function(k: string){ if (k.indexOf(prefix) === 0) add(map[k]); });
  });
  return found;
}

/* The one value refs point at, or null when they point at none or several
   (a resource spanning several subnets has no single subnet to sit in). */
export function singleReferencedValue<T>(map: Readonly<Record<string, T>>, refs: ReadonlyArray<string>): T | null {
  var found = referencedValues(map, refs);
  return found.length === 1 ? found[0] : null;
}
