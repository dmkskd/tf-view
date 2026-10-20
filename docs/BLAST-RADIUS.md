# Blast radius: challenges

Working notes on showing the blast radius of a planned change. Status: **the
code has been removed** (it was a half feature). These notes are kept so the
work can restart from what was learned. The questions below are still open.

## Goal

Given a Terraform plan, answer: **"this resource is changing, what else is
affected?"**

Scope decision: Terraform's perspective only. Show what the plan states, not
what we can guess about AWS behaviour.

## What the plan gives us

| Data | Where in the plan JSON |
|---|---|
| Action per resource | `resource_changes[].change.actions` |
| Reference graph | `configuration.root_module.resources[].expressions`, `depends_on` |
| Attribute diff | `change.before`, `change.after` |
| Unknown after apply | `change.after_unknown` |
| Why a replace | `change.replace_paths`, `action_reason` |
| Referenced attributes | top-level `relevant_attributes` (not always present) |
| Prior values | `prior_state` (not always present) |

It has no runtime data: no traffic, no usage, no resources outside the plan.

## What was built (since removed)

- `src/ts/core/blast.ts`: `analyzeBlastRadius(model, addr)`, pure and DOM-free.
- The origin must be a resource the plan updates, replaces or deletes.
- It follows config references transitively and keeps the path and hop count.
- Each affected resource is `changing` (the plan also changes it) or
  `referenced` (it depends on the origin, no change is planned).
- Each carries `via`, the attribute that refers to the step before it.
- A `stateful-loss` flag fires when a data store is destroyed or replaced.
- UI: banner, origin tag, hop badges, fading tint, labelled edges, hover card.
- Tests: `tools/test.js`, suite "blast radius".

## Challenges

### 1. Terraform records dependencies one way

The effect often flows the other way. A network ACL lists its `subnet_ids`, so
the NACL depends on the subnet and nothing depends on the NACL. Changing the
NACL affects everything in those subnets, but the graph says "no dependents".
The same goes for security group rules, route table associations and policy
attachments.

### 2. Nothing references some changed resources

A replaced instance, or a deleted log group, may have no dependents in the
config. The real impact (downtime, lost logs) is invisible to the graph.

### 3. "None" reads as "safe"

An empty result is a statement about the config, not about risk. The wording
must say `no references`, not `none`.

### 4. Knowing the effect needs resource knowledge

A curated "acts on" table (NACL, SG rule, ...) would fix cases like 1. But the
effect is not uniform. A NACL change affects all traffic in a subnet. A VPC
endpoint change barely touches the subnet, and who uses the endpoint is not in
the plan. Anything that needs a guess about who is affected is out of scope.
If a curated layer is added, it must be limited to cases where the config
itself proves the effect, and drawn differently from Terraform references.

### 5. Updates are coarser than the plan allows

Any update to a resource currently reaches everything that references it, even
if the dependent uses an attribute that did not change. `relevant_attributes`
and `after_unknown` could narrow this, but not every plan carries them.

### 6. Modules are not followed

The parser reads `configuration.root_module.resources` only, not
`module_calls`. Resources inside a module have empty `refs`, so their blast
radius is silently empty. The banner says `module links not followed` as a
stopgap. A real fix means mapping module-relative addresses to full ones and
following module inputs and outputs across the boundary.

### 7. Drawing: nesting versus edges

The layout expresses many relationships as nesting (subnet, security group,
AZ). Plain edges skip nested relationships, because the box already says it.
Blast radius edges currently skip containers entirely, so a container origin
(a subnet, a security group with members) draws no edges. Only tint and badges
show. Container origins need their own treatment.

### 8. Discoverability

Nothing on the canvas shows which changed tiles have a blast radius. Today it
is a right-click menu item, disabled with a reason when empty.

### 9. Hidden tiles

Some affected resources are not drawn, for example route table associations
(off by default) or anything filtered out. The banner counts what is drawn and
reports how many are not.

### 10. Evidence strength

`changing` is a fact the plan states. `referenced` is a dependency, not a
prediction. Neither says how bad the effect is, so severity is not shown.

## Naming

"Impact" and "ripple" were rejected. "Blast radius" is the term used by
Terraform tooling (for example Harness IaCM) and ops writing. Terraform's own
docs say "dependencies"; the reverse has no official name, tools say
"dependents". The origin is tagged with what the plan does to it (`replacing`,
`updating`, `deleting`); affected resources are `direct` or `indirect`.

## Options for the gaps

| Option | What | Trade-off |
|---|---|---|
| A | Keep it Terraform-only; relabel empty results as `no references`; explain the direction in the tooltip | Honest, but NACL-like cases stay empty |
| B | Add a small curated "acts on" layer, only where the config proves the effect | Useful, but it is type knowledge and needs upkeep |
| C | Leave semantic effects to the LLM layer, labelled as inferred | Covers what static cannot, but it is inference and opt-in |

Current direction: A, with B only if it stays small and visibly separate.

## LLM-assisted layer (not built)

- Feed it the static result (graph, paths, actions, attribute diffs), not the
  raw plan.
- Plan JSON contains sensitive values in plain text; `before_sensitive` and
  `after_sensitive` only mark them. Strip or mask them first.
- Require structured output and validate every returned address against the
  model.
- Keep static and LLM results visibly separate.
- Check how the existing `llmReview` path handles redaction before reusing it.

## Open questions

- Option A only, or A then a small B?
- Should changed tiles with a radius carry a marker, or stay right-click only?
- Fix container origins now, or after the model is settled?
- Is module support worth doing for this feature alone? It would also improve
  layout and edges.
