// test.js — unit tests for the parse and layout rules.
//
// WHAT IT CHECKS
//   Named assertions against hand-written minimal plans, so each rule is
//   pinned by intent rather than by recorded output. The check-*.js harnesses
//   stay as the regression net over the bundled plan; this file states what
//   the rules are supposed to do.
//
// HOW TO USE IT
//   node tools/test.js            all suites
//   node tools/test.js placement  only suites whose name contains "placement"
//   Exit code is non-zero on the first failing assertion count.

const { load } = require("./lib/app.js");
process.on("uncaughtException", e => { console.error(e); process.exit(1); });

const app = load();
const parsePlan = app.fn("parsePlan");
const buildTree = app.fn("buildTree");
const isSensitive = app.fn("isSensitive");
const baseAddr = app.fn("baseAddr");
const matchRules = app.fn("matchRules");
const modelSnapshot = app.fn("modelSnapshot");
const listRefs = app.fn("listRefs");

/* ---- runner ---------------------------------------------------------- */

const filter = process.argv[2] || "";
let pass = 0, fail = 0, suite = "";
const results = [];

function describe(name, fn) {
  if (filter && !name.includes(filter)) return;
  suite = name;
  fn();
}
function test(name, fn) {
  try { fn(); pass++; results.push(`  ok   ${name}`); }
  catch (e) { fail++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || "value"}: expected ${b}, got ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || "expected truthy"); }

/* ---- fixtures -------------------------------------------------------- */

// A plan is two parallel lists: resource_changes carries values and actions,
// configuration.root_module.resources carries the references. The helper
// keeps them in step so a fixture reads as one list of resources.
function plan(resources, extra) {
  const p = Object.assign({
    format_version: "1.2",
    terraform_version: "1.9.0",
    configuration: {
      provider_config: { aws: { name: "aws", expressions: { region: { constant_value: "eu-west-1" } } } },
      root_module: { resources: [] }
    },
    resource_changes: []
  }, extra || {});
  for (const r of resources) {
    const [type, name] = r.addr.split(".");
    p.resource_changes.push({
      address: r.addr, mode: "managed", type, name,
      change: {
        actions: r.actions || ["create"],
        before: r.before === undefined ? null : r.before,
        after: r.after || {},
        after_unknown: r.unknown || {},
        after_sensitive: r.sensitive || {}
      }
    });
    const expressions = {};
    for (const [k, refs] of Object.entries(r.refs || {})) expressions[k] = { references: refs };
    p.configuration.root_module.resources.push({
      address: r.addr, mode: "managed", type, name,
      expressions, depends_on: r.dependsOn || undefined
    });
  }
  return p;
}

const OPTS = { mode: "all", showAssoc: true, showUnsup: true, edges: "select" };

// Walks the built tree and returns addr -> label of the box holding the tile.
function placements(model, opts) {
  const tree = buildTree(model, Object.assign({}, OPTS, opts || {}));
  const where = {};
  (function walk(g, holder) {
    const label = g.box ? g.label + (g.meta ? " " + g.meta : "") : null;
    if (g.res) where[g.res.addr] = holder;
    if (g.box) g.children.forEach(k => walk(k, label));
  })(tree, "root");
  return where;
}
const built = (resources, opts) => placements(parsePlan(plan(resources), "t"), opts);

const VPC    = { addr: "aws_vpc.main", after: { cidr_block: "10.0.0.0/16" } };
const SUBNET = { addr: "aws_subnet.public", refs: { vpc_id: ["aws_vpc.main.id"] },
                 after: { availability_zone: "eu-west-1a", cidr_block: "10.0.1.0/24" } };

/* ---- suites ---------------------------------------------------------- */

describe("parse: shape and diagnostics", () => {
  test("a non-object is rejected with no resources", () => {
    const m = parsePlan("nope", "t");
    eq(m.resources.length, 0);
    eq(m.diagnostics[0].code, "not-json");
  });

  test("a state file falls back to planned_values", () => {
    const m = parsePlan({
      format_version: "1.0",
      values: { root_module: { resources: [] } },
      planned_values: { root_module: { resources: [
        { address: "aws_vpc.main", mode: "managed", type: "aws_vpc", name: "main", values: { cidr_block: "10.0.0.0/16" } }
      ] } }
    }, "t");
    eq(m.resources.length, 1);
    ok(m.diagnostics.some(d => d.code === "state-file"), "state-file diagnostic");
  });

  test("a provider with no plugin is reported, not drawn", () => {
    const m = parsePlan(plan([{ addr: "azurerm_resource_group.x" }]), "t");
    eq(m.resources[0].foreign, true);
    ok(m.diagnostics.some(d => d.code === "no-provider"), "no-provider diagnostic");
  });

  test("an unknown aws type is flagged unsupported, not dropped", () => {
    const m = parsePlan(plan([{ addr: "aws_quantum_thing.x" }]), "t");
    eq(m.resources[0].supported, false);
    ok(m.diagnostics.some(d => d.code === "unsupported"), "unsupported diagnostic");
  });
});

describe("parse: references", () => {
  test("a reference is truncated to type.name", () => {
    const m = parsePlan(plan([VPC, SUBNET]), "t");
    eq(m.byAddr["aws_subnet.public"].refs, ["aws_vpc.main"]);
  });

  test("var, local, each, count and data references are dropped", () => {
    const m = parsePlan(plan([{ addr: "aws_instance.web", refs: {
      tags: ["var.name_prefix"], ami: ["data.aws_ami.al2023.id"],
      count: ["count.index"], x: ["local.x"], y: ["each.key"]
    } }]), "t");
    eq(m.byAddr["aws_instance.web"].refs, []);
  });

  test("depends_on counts as a reference", () => {
    const m = parsePlan(plan([VPC, { addr: "aws_nat_gateway.n", dependsOn: ["aws_vpc.main"] }]), "t");
    eq(m.byAddr["aws_nat_gateway.n"].refs, ["aws_vpc.main"]);
  });

  test("a count/for_each instance resolves refs from its base config address", () => {
    // configuration.root_module.resources keys a counted resource by its base
    // address ("aws_subnet.public"); resource_changes carries the per-instance
    // address ("aws_subnet.public[0]"). The two must still line up.
    const p = plan([VPC]);
    p.resource_changes.push({
      address: "aws_subnet.public[0]", mode: "managed", type: "aws_subnet", name: "public",
      change: { actions: ["create"], before: null,
                after: { availability_zone: "eu-west-1a", cidr_block: "10.0.1.0/24" },
                after_unknown: {}, after_sensitive: {} }
    });
    p.configuration.root_module.resources.push({
      address: "aws_subnet.public", mode: "managed", type: "aws_subnet", name: "public",
      expressions: { vpc_id: { references: ["aws_vpc.main.id"] } }
    });
    const m = parsePlan(p, "t");
    eq(m.byAddr["aws_subnet.public[0]"].refs, ["aws_vpc.main"]);
  });

  test("a count/for_each instance's cfgByAddr lookup also uses the base address", () => {
    // ui/detail.js reconstructs the Terraform block from
    // model.cfgByAddr[baseAddr(r.addr)] — same base/instance mismatch as refs.
    const p = plan([VPC]);
    p.resource_changes.push({
      address: "aws_subnet.public[0]", mode: "managed", type: "aws_subnet", name: "public",
      change: { actions: ["create"], before: null,
                after: { availability_zone: "eu-west-1a", cidr_block: "10.0.1.0/24" },
                after_unknown: {}, after_sensitive: {} }
    });
    p.configuration.root_module.resources.push({
      address: "aws_subnet.public", mode: "managed", type: "aws_subnet", name: "public",
      expressions: { vpc_id: { references: ["aws_vpc.main.id"] } }
    });
    const m = parsePlan(p, "t");
    const r = m.byAddr["aws_subnet.public[0]"];
    ok(m.cfgByAddr[baseAddr(r.addr)], "cfgByAddr has an entry for the base address");
    eq(m.cfgByAddr[baseAddr(r.addr)].address, "aws_subnet.public");
  });
});

describe("parse: sensitive shape mirror", () => {
  test("a mirror masks when any leaf is true", () => {
    eq(isSensitive({ password: true }), true);
    eq(isSensitive([{ x: false }, { y: true }]), true);
    eq(isSensitive({ tags: { Name: false } }), false);
  });
});

describe("layout: placement", () => {

  test("a resource sits in the first subnet it references", () => {
    const where = built([VPC, SUBNET,
      { addr: "aws_instance.web", refs: { subnet_id: ["aws_subnet.public.id"] } }]);
    eq(where["aws_instance.web"], "Subnet public 10.0.1.0/24");
  });

  test("a resource referencing only the vpc sits in the VPC-wide section", () => {
    const where = built([VPC, SUBNET,
      { addr: "aws_internet_gateway.igw", refs: { vpc_id: ["aws_vpc.main.id"] } }]);
    eq(where["aws_internet_gateway.igw"], "VPC-wide spans or sits outside AZs");
  });

  test("a count/for_each subnet instance nests inside its vpc, not Unplaced", () => {
    const p = plan([VPC]);
    p.resource_changes.push({
      address: "aws_subnet.public[0]", mode: "managed", type: "aws_subnet", name: "public",
      change: { actions: ["create"], before: null,
                after: { availability_zone: "eu-west-1a", cidr_block: "10.0.1.0/24" },
                after_unknown: {}, after_sensitive: {} }
    });
    p.configuration.root_module.resources.push({
      address: "aws_subnet.public", mode: "managed", type: "aws_subnet", name: "public",
      expressions: { vpc_id: { references: ["aws_vpc.main.id"] } }
    });
    const where = placements(parsePlan(p, "t"));
    eq(where["aws_subnet.public[0]"], "Availability Zone eu-west-1a");
  });

  test("a splat reference to a counted subnet still resolves to an instance", () => {
    // aws_db_subnet_group.subnet_ids = aws_subnet.public[*].id collapses to
    // the base address ("aws_subnet.public") in expressions.references, with
    // no [N] — but subnetGroups is keyed per-instance ("aws_subnet.public[0]").
    const p = plan([VPC]);
    p.resource_changes.push({
      address: "aws_subnet.public[0]", mode: "managed", type: "aws_subnet", name: "public",
      change: { actions: ["create"], before: null,
                after: { availability_zone: "eu-west-1a", cidr_block: "10.0.1.0/24" },
                after_unknown: {}, after_sensitive: {} }
    });
    p.configuration.root_module.resources.push({
      address: "aws_subnet.public", mode: "managed", type: "aws_subnet", name: "public",
      expressions: { vpc_id: { references: ["aws_vpc.main.id"] } }
    });
    p.resource_changes.push({
      address: "aws_db_subnet_group.main", mode: "managed", type: "aws_db_subnet_group", name: "main",
      change: { actions: ["create"], before: null, after: {}, after_unknown: {}, after_sensitive: {} }
    });
    p.configuration.root_module.resources.push({
      address: "aws_db_subnet_group.main", mode: "managed", type: "aws_db_subnet_group", name: "main",
      expressions: { subnet_ids: { references: ["aws_subnet.public"] } }
    });
    const where = placements(parsePlan(p, "t"));
    eq(where["aws_db_subnet_group.main"], "Subnet public 10.0.1.0/24");
  });

  test("a specific instance reference isn't confused for a splat by its own redundant base form", () => {
    // Terraform's own references list for one ordinary reference like
    // aws_subnet.public[0].id includes BOTH the specific instance address
    // ("aws_subnet.public[0]") AND the bare base address ("aws_subnet.public")
    // in the same array — not because it spans every instance, just because
    // Terraform names the referenced object at several levels of
    // specificity. A second subnet instance existing elsewhere must not
    // make that base form look like a real splat across both.
    const p = plan([VPC]);
    ["aws_subnet.public[0]", "aws_subnet.public[1]"].forEach((addr, i) => {
      p.resource_changes.push({
        address: addr, mode: "managed", type: "aws_subnet", name: "public",
        change: { actions: ["create"], before: null,
                  after: { availability_zone: "eu-west-1" + (i ? "b" : "a"), cidr_block: "10.0." + i + ".0/24" },
                  after_unknown: {}, after_sensitive: {} }
      });
    });
    p.configuration.root_module.resources.push({
      address: "aws_subnet.public", mode: "managed", type: "aws_subnet", name: "public",
      expressions: { vpc_id: { references: ["aws_vpc.main.id"] } }
    });
    p.resource_changes.push({
      address: "aws_instance.web", mode: "managed", type: "aws_instance", name: "web",
      change: { actions: ["create"], before: null, after: {}, after_unknown: {}, after_sensitive: {} }
    });
    p.configuration.root_module.resources.push({
      address: "aws_instance.web", mode: "managed", type: "aws_instance", name: "web",
      expressions: { subnet_id: {
        references: ["aws_subnet.public[0].id", "aws_subnet.public[0]", "aws_subnet.public"] } }
    });
    const where = placements(parsePlan(p, "t"));
    eq(where["aws_instance.web"], "Subnet public 10.0.0.0/24");
  });

  test("an iam resource sits at account level whatever it references", () => {
    const where = built([VPC, SUBNET,
      { addr: "aws_iam_role.ssm", refs: { x: ["aws_subnet.public.id"] } }]);
    eq(where["aws_iam_role.ssm"], "Global account-level");
  });

  test("a resource referencing nothing placeable is drawn under Unplaced", () => {
    const where = built([VPC, SUBNET, { addr: "aws_eip.nat", after: { domain: "vpc" } }]);
    eq(where["aws_eip.nat"], "Unplaced no vpc or subnet reference");
  });

  test("one hop back along a reference places an otherwise unplaced resource", () => {
    const where = built([VPC, SUBNET,
      { addr: "aws_eip.nat", after: { domain: "vpc" } },
      { addr: "aws_nat_gateway.nat", refs: {
        allocation_id: ["aws_eip.nat.id"], subnet_id: ["aws_subnet.public.id"] } }]);
    eq(where["aws_eip.nat"], "Subnet public 10.0.1.0/24");
    eq(where["aws_nat_gateway.nat"], "Subnet public 10.0.1.0/24");
  });

  test("a security group becomes a boundary around what references it", () => {
    const where = built([VPC, SUBNET,
      { addr: "aws_security_group.web", refs: { vpc_id: ["aws_vpc.main.id"] } },
      { addr: "aws_instance.web", refs: {
        subnet_id: ["aws_subnet.public.id"], vpc_security_group_ids: ["aws_security_group.web.id"] } }]);
    eq(where["aws_instance.web"], "Security group web");
  });

  test("one security group shared across two subnets draws two boundaries, not one", () => {
    const SUBNET2 = { addr: "aws_subnet.private", refs: { vpc_id: ["aws_vpc.main.id"] },
                       after: { availability_zone: "eu-west-1b", cidr_block: "10.0.2.0/24" } };
    const model = parsePlan(plan([VPC, SUBNET, SUBNET2,
      { addr: "aws_security_group.web", refs: { vpc_id: ["aws_vpc.main.id"] } },
      { addr: "aws_instance.a", refs: {
        subnet_id: ["aws_subnet.public.id"], vpc_security_group_ids: ["aws_security_group.web.id"] } },
      { addr: "aws_instance.b", refs: {
        subnet_id: ["aws_subnet.private.id"], vpc_security_group_ids: ["aws_security_group.web.id"] } }]), "t");
    const tree = buildTree(model, OPTS);
    const sgBoxes = [];
    (function walk(g){ if (g.box){ if (g.cls === "sg") sgBoxes.push(g); g.children.forEach(walk); } })(tree);
    eq(sgBoxes.length, 2, "two separate Security group web boxes");
    const members = sgBoxes.map(g => g.children.map(c => c.res.addr).sort());
    eq(members.sort(), [["aws_instance.a"], ["aws_instance.b"]], "each boundary holds only its own subnet's member");
  });

  test("a resource referencing two security groups keeps the first one referenced, not the last one declared", () => {
    // sg1 is declared before sg2 in the plan (so sg2 is last-declared), but
    // the instance's own vpc_security_group_ids lists sg1 first (so sg1 is
    // first-referenced). Ownership must follow reference order — a bug that
    // instead picks whichever SG is processed last while building the boxes
    // would give sg2 here, not sg1.
    const where = built([VPC, SUBNET,
      { addr: "aws_security_group.sg1", refs: { vpc_id: ["aws_vpc.main.id"] } },
      { addr: "aws_security_group.sg2", refs: { vpc_id: ["aws_vpc.main.id"] } },
      { addr: "aws_instance.web", refs: {
        subnet_id: ["aws_subnet.public.id"],
        vpc_security_group_ids: ["aws_security_group.sg1.id", "aws_security_group.sg2.id"] } }]);
    eq(where["aws_instance.web"], "Security group sg1");
  });

  test("two AZs that fit side by side pack into one row, not one per row", () => {
    const SUBNET2 = { addr: "aws_subnet.private", refs: { vpc_id: ["aws_vpc.main.id"] },
                       after: { availability_zone: "eu-west-1b", cidr_block: "10.0.2.0/24" } };
    const tree = buildTree(parsePlan(plan([VPC, SUBNET, SUBNET2]), "t"), OPTS);
    const azBoxes = [];
    (function walk(g){ if (g.box){ if (g.cls === "az") azBoxes.push(g); g.children.forEach(walk); } })(tree);
    eq(azBoxes.length, 2, "two AZ boxes");
    eq(azBoxes[0].y, azBoxes[1].y, "same row");
    ok(azBoxes[0].x !== azBoxes[1].x, "different columns");
  });

  test("a multi-AZ resource sits below the AZs in its VPC", () => {
    const SUBNET2 = { addr: "aws_subnet.private", refs: { vpc_id: ["aws_vpc.main.id"] },
                       after: { availability_zone: "eu-west-1b", cidr_block: "10.0.2.0/24" } };
    const model = parsePlan(plan([VPC, SUBNET, SUBNET2,
      { addr: "aws_autoscaling_group.app", refs: {
        vpc_zone_identifier: ["aws_subnet.public.id", "aws_subnet.private.id"] } }]), "t");
    const tree = buildTree(model, OPTS);
    const vpc = tree.children[0].children.find(g => g.cls === "vpc");
    const azs = vpc.children.filter(g => g.cls === "az");
    const wide = vpc.children.find(g => g.cls === "vpc-wide");
    eq(azs.length, 2);
    ok(wide && wide.y > Math.max(...azs.map(g => g.y)), "VPC-wide row follows AZ row");
    eq(wide.children[0].res.addr, "aws_autoscaling_group.app");
  });

  test("a launch template is not enclosed by a security group", () => {
    const where = built([VPC, SUBNET,
      { addr: "aws_security_group.app", refs: { vpc_id: ["aws_vpc.main.id"] } },
      { addr: "aws_launch_template.app", refs: {
        vpc_security_group_ids: ["aws_security_group.app.id"] } },
      { addr: "aws_instance.app", refs: {
        subnet_id: ["aws_subnet.public.id"],
        vpc_security_group_ids: ["aws_security_group.app.id"] } }]);
    eq(where["aws_launch_template.app"], "Region eu-west-1");
    eq(where["aws_instance.app"], "Security group app");
  });
});

describe("layout: filters", () => {
  const changing = [VPC, SUBNET,
    { addr: "aws_instance.web", actions: ["update"], refs: { subnet_id: ["aws_subnet.public.id"] } },
    { addr: "aws_instance.idle", actions: ["no-op"], refs: { subnet_id: ["aws_subnet.public.id"] } }];

  test("an action filter also applies to a security group drawn as a tile", () => {
    const where = built(changing.concat([
      { addr: "aws_security_group.unused", actions: ["no-op"], refs: { vpc_id: ["aws_vpc.main.id"] } }]),
      { mode: "changes", action: "update" });
    ok(!where["aws_security_group.unused"], "the no-op security group is filtered out");
  });
});

describe("diff: rule matching", () => {
  const a = { from_port: 443, to_port: 443, protocol: "tcp", cidr_blocks: ["10.0.0.0/16"] };
  const b = { from_port: 1024, to_port: 65535, protocol: "tcp", cidr_blocks: ["0.0.0.0/0"] };

  test("a set matches by content, not by position", () => {
    const m = matchRules([a, b], [b, a], "set");
    eq(m.filter(r => r.mark !== "").length, 0, "no rule reported changed");
  });

  test("a list matches by position, so a reorder is a change", () => {
    const m = matchRules([a, b], [b, a], "list");
    ok(m.some(r => r.mark !== ""), "a reorder shows as a change");
  });
});

describe("parse: non-resource sections become typed fields", () => {
  const withExtras = () => parsePlan(plan([VPC], {
    variables: { region: { value: "eu-west-1" }, flag: { value: true } },
    output_changes: {
      vpc_id: { actions: ["create"], after_unknown: true },
      secret: { actions: ["create"], after: "x", after_sensitive: true },
      name: { actions: ["no-op"], after: "main" }
    },
    resource_drift: [{ address: "aws_vpc.main", type: "aws_vpc", name: "main",
      change: { actions: ["update"], before: { a: 1 }, after: { a: 2 } } }],
    checks: [{ address: { kind: "check", to_display: "check.health" }, status: "fail",
      instances: [{ problems: [{ message: "bad" }, { message: "worse" }] }] }]
  }), "t");

  test("variables are name to value", () => {
    eq(withExtras().variables, { region: "eu-west-1", flag: true });
  });

  test("outputs are normalised, with unknown and sensitive as booleans", () => {
    const o = withExtras().outputs;
    eq(o.vpc_id.afterUnknown, true);
    eq(o.secret.afterSensitive, true);
    eq(o.name.after, "main");
    eq(o.name.afterUnknown, false);
  });

  test("drift carries before and after", () => {
    eq(withExtras().driftDetails, [{ address: "aws_vpc.main", type: "aws_vpc", name: "main",
      before: { a: 1 }, after: { a: 2 } }]);
  });

  test("a check keeps its status and flattens its problems", () => {
    eq(withExtras().checks, [{ name: "check.health", status: "fail", problems: ["bad", "worse"] }]);
  });

  test("a plan with none of them has empty fields, not undefined", () => {
    const m = parsePlan(plan([VPC]), "t");
    eq([m.variables, m.driftDetails, m.checks, m.outputs], [{}, [], [], null]);
  });
});

describe("parse: modules", () => {
  // resource_changes is flat and fully qualified; configuration is nested, with
  // addresses relative to each module. The helper builds both from one list.
  const rc = (addr, actions) => {
    const parts = addr.split(".");
    const strip = x => x.replace(/\[.*$/, "");
    const mod = [];
    let i = 0;
    while (parts[i] === "module") { mod.push("module." + parts[i + 1]); i += 2; }
    return {
      address: addr, mode: "managed", type: strip(parts[i]), name: strip(parts[i + 1]),
      module_address: mod.length ? mod.join(".") : undefined,
      change: { actions: actions || ["no-op"], before: {}, after: {}, after_unknown: {}, after_sensitive: {} }
    };
  };
  const res = (type, name, refs, dependsOn) => ({
    address: type + "." + name, mode: "managed", type, name,
    expressions: Object.fromEntries(Object.entries(refs || {}).map(([k, r]) => [k, { references: r }])),
    depends_on: dependsOn
  });
  const modPlan = (addrs, root) => ({
    format_version: "1.2",
    resource_changes: addrs.map(a => rc(a)),
    configuration: { provider_config: { aws: { name: "aws", expressions: { region: { constant_value: "eu-west-1" } } } },
                     root_module: root }
  });
  const refsOf = (m, a) => m.byAddr[a].refs;

  // module.net: a vpc and a subnet in it, the subnet exposed as an output
  const net = (extra) => Object.assign({
    resources: [
      res("aws_vpc", "main"),
      res("aws_subnet", "a", { vpc_id: ["aws_vpc.main.id", "aws_vpc.main"], cidr_block: ["var.cidr"] })
    ],
    outputs: { subnet_id: { expression: { references: ["aws_subnet.a.id", "aws_subnet.a"] } } }
  }, extra);

  test("a resource inside a module refers to its siblings by qualified address", () => {
    const m = parsePlan(modPlan(["module.net.aws_vpc.main", "module.net.aws_subnet.a"], {
      resources: [], module_calls: { net: { expressions: {}, module: net() } } }), "t");
    eq(refsOf(m, "module.net.aws_subnet.a"), ["module.net.aws_vpc.main"]);
  });

  test("a root resource reaches into a module through its output", () => {
    const m = parsePlan(modPlan(["module.net.aws_vpc.main", "module.net.aws_subnet.a", "aws_instance.web"], {
      resources: [res("aws_instance", "web", { subnet_id: ["module.net.subnet_id", "module.net"] })],
      module_calls: { net: { expressions: {}, module: net() } } }), "t");
    eq(refsOf(m, "aws_instance.web"), ["module.net.aws_subnet.a"]);
  });

  test("dependents are linked across the module boundary", () => {
    const m = parsePlan(modPlan(["module.net.aws_vpc.main", "module.net.aws_subnet.a", "aws_instance.web"], {
      resources: [res("aws_instance", "web", { subnet_id: ["module.net.subnet_id"] })],
      module_calls: { net: { expressions: {}, module: net() } } }), "t");
    eq(m.byAddr["module.net.aws_subnet.a"].dependents, ["aws_instance.web"]);
    eq(m.byAddr["module.net.aws_vpc.main"].dependents, ["module.net.aws_subnet.a"]);
  });

  test("var.x resolves to what the caller passed in", () => {
    // outer passes aws_vpc.v to inner as vpc_id; inner's subnet uses var.vpc_id
    const inner = { resources: [res("aws_subnet", "s", { vpc_id: ["var.vpc_id"] })], outputs: {} };
    const outer = { resources: [res("aws_vpc", "v")],
      module_calls: { inner: { expressions: { vpc_id: { references: ["aws_vpc.v.id", "aws_vpc.v"] } }, module: inner } } };
    const m = parsePlan(modPlan(["module.outer.aws_vpc.v", "module.outer.module.inner.aws_subnet.s"], {
      resources: [], module_calls: { outer: { expressions: {}, module: outer } } }), "t");
    eq(refsOf(m, "module.outer.module.inner.aws_subnet.s"), ["module.outer.aws_vpc.v"]);
  });

  test("var.x resolves up to a resource in the root", () => {
    const inner = { resources: [res("aws_subnet", "s", { vpc_id: ["var.vpc_id"] })], outputs: {} };
    const m = parsePlan(modPlan(["aws_vpc.main", "module.net.aws_subnet.s"], {
      resources: [res("aws_vpc", "main")],
      module_calls: { net: { expressions: { vpc_id: { references: ["aws_vpc.main.id"] } }, module: inner } } }), "t");
    eq(refsOf(m, "module.net.aws_subnet.s"), ["aws_vpc.main"]);
  });

  test("each instance of a counted module refers to its own siblings", () => {
    const m = parsePlan(modPlan([
      "module.net[0].aws_vpc.main", "module.net[0].aws_subnet.a",
      "module.net[1].aws_vpc.main", "module.net[1].aws_subnet.a"], {
      resources: [], module_calls: { net: { expressions: {}, module: net() } } }), "t");
    eq(refsOf(m, "module.net[0].aws_subnet.a"), ["module.net[0].aws_vpc.main"]);
    eq(refsOf(m, "module.net[1].aws_subnet.a"), ["module.net[1].aws_vpc.main"]);
  });

  test("an output reference with an instance key picks that instance", () => {
    const m = parsePlan(modPlan([
      "module.net[0].aws_vpc.main", "module.net[0].aws_subnet.a",
      "module.net[1].aws_vpc.main", "module.net[1].aws_subnet.a", "aws_instance.web"], {
      resources: [res("aws_instance", "web", { subnet_id: ["module.net[1].subnet_id"] })],
      module_calls: { net: { expressions: {}, module: net() } } }), "t");
    eq(refsOf(m, "aws_instance.web"), ["module.net[1].aws_subnet.a"]);
  });

  test("depends_on a module means everything inside it", () => {
    const m = parsePlan(modPlan(["module.net.aws_vpc.main", "module.net.aws_subnet.a", "aws_instance.web"], {
      resources: [res("aws_instance", "web", {}, ["module.net"])],
      module_calls: { net: { expressions: {}, module: net() } } }), "t");
    eq(refsOf(m, "aws_instance.web"), ["module.net.aws_vpc.main", "module.net.aws_subnet.a"]);
  });

  test("a depends_on on the module call holds for every resource inside", () => {
    const m = parsePlan(modPlan(["aws_iam_role.r", "module.net.aws_vpc.main", "module.net.aws_subnet.a"], {
      resources: [res("aws_iam_role", "r")],
      module_calls: { net: { expressions: {}, depends_on: ["aws_iam_role.r"], module: net() } } }), "t");
    ok(refsOf(m, "module.net.aws_vpc.main").indexOf("aws_iam_role.r") >= 0, "vpc depends on the role");
    ok(refsOf(m, "module.net.aws_subnet.a").indexOf("aws_iam_role.r") >= 0, "subnet depends on the role");
  });

  test("the resource records the module it lives in", () => {
    const m = parsePlan(modPlan(["module.net[0].aws_vpc.main", "aws_iam_role.r"], {
      resources: [res("aws_iam_role", "r")],
      module_calls: { net: { expressions: {}, module: net() } } }), "t");
    eq(m.byAddr["module.net[0].aws_vpc.main"].module, "module.net[0]");
    eq(m.byAddr["aws_iam_role.r"].module || "", "");
  });

  test("modules are no longer reported as unimplemented", () => {
    const m = parsePlan(modPlan(["module.net.aws_vpc.main"], {
      resources: [], module_calls: { net: { expressions: {}, module: net() } } }), "t");
    ok(!m.diagnostics.some(d => d.code === "module"), "no module warning");
    ok(!m.diagnostics.some(d => d.code === "no-config"), "configuration was read");
  });

  test("a reference into a module that has nothing in the plan is dropped", () => {
    const m = parsePlan(modPlan(["aws_instance.web"], {
      resources: [res("aws_instance", "web", { subnet_id: ["module.net.subnet_id"] })],
      module_calls: { net: { expressions: {}, module: net() } } }), "t");
    eq(refsOf(m, "aws_instance.web"), []);
  });
});

describe("detail: dependency list", () => {
  const known = { "aws_sg.this[0]": 1, "aws_sg.other": 1, "aws_sub.p[0]": 1, "aws_sub.p[1]": 1 };

  test("a bare base is dropped when its specific form is listed", () => {
    eq(listRefs(["aws_sg.this[0]", "aws_sg.this"], known).map(r => r.addr), ["aws_sg.this[0]"]);
  });

  test("a bare base with no specific form expands to the instances that exist", () => {
    eq(listRefs(["aws_sub.p"], known).map(r => r.addr), ["aws_sub.p[0]", "aws_sub.p[1]"]);
  });

  test("something not in the plan is kept but marked, not linked", () => {
    eq(listRefs(["aws_log.gone"], known), [{ addr: "aws_log.gone", inPlan: false }]);
  });

  test("a resource with no instance key is a plain link", () => {
    eq(listRefs(["aws_sg.other"], known), [{ addr: "aws_sg.other", inPlan: true }]);
  });

  test("duplicates collapse", () => {
    eq(listRefs(["aws_sg.other", "aws_sg.other"], known).length, 1);
  });
});

describe("parse: the saved state graph adds links the configuration cannot show", () => {
  // The NAT gateway reaches the EIP through a local, so the configuration gives
  // it no reference; prior_state records the dependency.
  const withState = (resources, deps, extraRefs) => {
    const p = plan(resources);
    p.prior_state = { values: { root_module: { resources: Object.keys(deps).map(a => {
      const [type, name] = a.replace(/\[.*$/, "").split(".");
      return { address: a, mode: "managed", type, name, depends_on: deps[a] };
    }) } } };
    return parsePlan(p, "t");
  };
  const EIP = { addr: "aws_eip.nat[0]", actions: ["no-op"], before: {}, after: {} };
  const NAT = { addr: "aws_nat_gateway.this[0]", actions: ["no-op"], before: {}, after: {} };

  test("a dependency only the state knows becomes a link", () => {
    const m = withState([EIP, NAT], { "aws_nat_gateway.this[0]": ["aws_eip.nat"] });
    eq(m.byAddr["aws_nat_gateway.this[0]"].refs, ["aws_eip.nat[0]"]);
    eq(m.byAddr["aws_eip.nat[0]"].dependents, ["aws_nat_gateway.this[0]"]);
  });

  test("the links that came only from state are recorded", () => {
    const m = withState([EIP, NAT], { "aws_nat_gateway.this[0]": ["aws_eip.nat"] });
    eq(m.byAddr["aws_nat_gateway.this[0]"].stateRefs, ["aws_eip.nat[0]"]);
    eq(m.byAddr["aws_eip.nat[0]"].stateRefs, undefined);
  });

  test("a bare base widens to every instance that exists", () => {
    const A = { addr: "aws_subnet.p[0]", actions: ["no-op"], before: {}, after: {} };
    const B = { addr: "aws_subnet.p[1]", actions: ["no-op"], before: {}, after: {} };
    const T = { addr: "aws_lb.front", actions: ["no-op"], before: {}, after: {} };
    const m = withState([A, B, T], { "aws_lb.front": ["aws_subnet.p"] });
    eq(m.byAddr["aws_lb.front"].refs, ["aws_subnet.p[0]", "aws_subnet.p[1]"]);
  });

  test("it does not widen what the configuration already named", () => {
    // the config points at p[0]; widening the state's bare "p" to p[1] too would
    // make one subnet look like a splat and pull the instance out of it
    const A = { addr: "aws_subnet.p[0]", actions: ["no-op"], before: {}, after: {} };
    const B = { addr: "aws_subnet.p[1]", actions: ["no-op"], before: {}, after: {} };
    const I = { addr: "aws_instance.w", actions: ["no-op"], before: {}, after: {},
                refs: { subnet_id: ["aws_subnet.p[0].id", "aws_subnet.p[0]", "aws_subnet.p"] } };
    const m = withState([A, B, I], { "aws_instance.w": ["aws_subnet.p"] });
    eq(m.byAddr["aws_instance.w"].refs, ["aws_subnet.p[0]"]);
    eq(m.byAddr["aws_instance.w"].stateRefs, undefined);
  });

  test("a link the configuration already has is not repeated", () => {
    const m = withState([EIP, NAT].map(x => x), { "aws_nat_gateway.this[0]": ["aws_eip.nat[0]"] });
    eq(m.byAddr["aws_nat_gateway.this[0]"].refs.length, 1);
  });

  test("data sourceAddresses and unknown addresses are ignored", () => {
    const m = withState([EIP, NAT], { "aws_nat_gateway.this[0]": ["data.aws_availability_zones.available", "aws_gone.x"] });
    eq(m.byAddr["aws_nat_gateway.this[0]"].refs, []);
  });

  test("state links reach into modules, which nest in prior_state", () => {
    const p = plan([
      { addr: "module.n.aws_eip.nat[0]", actions: ["no-op"], before: {}, after: {} },
      { addr: "module.n.aws_nat_gateway.this[0]", actions: ["no-op"], before: {}, after: {} }]);
    p.prior_state = { values: { root_module: { child_modules: [{ address: "module.n", resources: [
      { address: "module.n.aws_nat_gateway.this[0]", mode: "managed", type: "aws_nat_gateway", name: "this",
        depends_on: ["module.n.aws_eip.nat"] }] }] } } };
    const m = parsePlan(p, "t");
    eq(m.byAddr["module.n.aws_nat_gateway.this[0]"].refs, ["module.n.aws_eip.nat[0]"]);
  });

  test("a plan with no prior_state is unchanged", () => {
    const m = parsePlan(plan([EIP, NAT]), "t");
    eq(m.byAddr["aws_nat_gateway.this[0]"].refs, []);
  });
});

describe("snapshot: the parsed model as plain data", () => {
  const snap = (withAttrs) => modelSnapshot(parsePlan(plan([
    VPC,
    { addr: "aws_subnet.public", refs: { vpc_id: ["aws_vpc.main.id"] },
      after: { cidr_block: "10.0.1.0/24", secret: "hunter2" } }
  ], { variables: { token: { value: "var-secret-value" } } }), "t"), withAttrs);

  test("each resource carries its links and dependents", () => {
    const r = snap().resources.find(x => x.addr === "aws_subnet.public");
    eq(r.refs, ["aws_vpc.main"]);
    eq(snap().resources.find(x => x.addr === "aws_vpc.main").dependents, ["aws_subnet.public"]);
  });

  test("attribute values are left out unless asked for", () => {
    eq(JSON.stringify(snap()).includes("hunter2"), false);
    eq(JSON.stringify(snap(true)).includes("hunter2"), true);
  });

  test("variables are listed by name only", () => {
    eq(snap().variables, ["token"]);
    eq(JSON.stringify(snap()).includes("var-secret-value"), false);
  });

  test("it is plain data: it survives a JSON round trip unchanged", () => {
    const a = snap();
    eq(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(a)));
    ok(Array.isArray(a.resources) && a.resources.length === 2, "two resources");
  });
});

describe("plan: the bundled sample", () => {
  const model = parsePlan(app.samplePlan(), "sample");

  test("no resource is left unplaced", () => {
    const where = placements(model);
    const loose = Object.entries(where).filter(([, box]) => box.startsWith("Unplaced"));
    eq(loose.map(([a]) => a), []);
  });

  test("the sample carries no account identifier", () => {
    const text = JSON.stringify(app.samplePlan());
    eq(text.match(/\b\d{12}\b/g), null, "12-digit account id");
  });
});

describe("security: copyable commands", () => {
  const { execFileSync } = require("child_process");
  const commandLine = app.fn("commandLine");
  const cliCommands = app.fn("cliCommands");
  /* Every payload only prints a marker if it ever runs: should quoting regress,
     the extra output fails the assertion and nothing else happens. Never put a
     command with side effects here. */
  const HOSTILE = ["$(printf INJECTED)", "`printf INJECTED`", "a'b", 'a"b', "x; printf INJECTED",
                   "x && printf INJECTED", "x | printf INJECTED", "a\\b", "$HOME",
                   "!!", "=ls", "~root", "*", "sg[0]", "a b", "{a,b}", "it's $(id)", "100%"];

  /* What a shell actually passes to the program for this command line. */
  function shellArgs(shell, line) {
    const out = execFileSync(shell, ["-c", "set -- " + line + "; for a in \"$@\"; do printf '%s\\0' \"$a\"; done"],
                             { encoding: "utf8" });
    return out.split("\0").slice(0, -1);
  }
  const shells = ["/bin/sh", "/bin/zsh", "/bin/bash"].filter(s => require("fs").existsSync(s));

  for (const sh of shells) {
    test(`${sh} receives every hostile value as one literal argument`, () => {
      for (const v of HOSTILE) eq(shellArgs(sh, commandLine(["aws", "--x", v])), ["aws", "--x", v], v);
    });
  }

  test("a placeholder is quoted, so the shell does not read it as a redirection", () => {
    const os = require("os"), fs = require("fs"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfview-shell-"));
    try {
      fs.writeFileSync(path.join(dir, "output"), "keep me");
      const line = commandLine(["printf", "%s", "<input>", "output"]);
      eq(line, "printf %s '<input>' output");
      for (const sh of shells) {
        const out = execFileSync(sh, ["-c", line], { cwd: dir, encoding: "utf8" });
        eq(out, "<input>output", sh + " output");
        eq(fs.readFileSync(path.join(dir, "output"), "utf8"), "keep me", sh + " left the file alone");
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("a value with a control character drops the command", () => {
    eq(commandLine(["aws", "a\nb"]), null);
    eq(commandLine(["aws", "a\u0000b"]), null);
    eq(commandLine(["aws", 42]), null);
  });

  test("hostile plan values in a generated command reach the program as literal arguments", () => {
    const r = { type: "aws_lambda_function", name: "f", attrs: { function_name: "x$(printf INJECTED)" } };
    const cmds = cliCommands(r, { defaultProviderSettings: { aws: { region: "us-east-1; printf INJECTED" } } });
    ok(cmds.length === 2, "two recipes");
    for (const sh of shells) {
      eq(shellArgs(sh, cmds[0].cmd),
         ["aws", "lambda", "get-function", "--region", "us-east-1; printf INJECTED", "--function-name", "x$(printf INJECTED)"], sh);
    }
  });

  test("a hostile name prefix stays inside its JMESPath string literal", () => {
    const r = { type: "aws_security_group", name: "s", attrs: { name_prefix: "a')]|[?'" } };
    const q = cliCommands(r, {}).find(c => c.label === "Find by prefix");
    const args = shellArgs("/bin/sh", q.cmd);
    eq(args[args.indexOf("--query") + 1],
       "SecurityGroups[?starts_with(GroupName, 'a\\')]|[?\\'')].{Id:GroupId,Name:GroupName}");
  });
});

describe("security: diagnostics are plain text", () => {
  const emphasisHtml = app.fn("emphasisHtml");

  test("a format_version containing markup is kept as text and rendered escaped", () => {
    const m = parsePlan(plan([], { format_version: "2<img src=x onerror=alert(1)>" }), "t");
    const d = m.diagnostics.find(x => x.code === "format-version");
    ok(d, "format-version diagnostic");
    ok(d.msg.includes("2<img src=x onerror=alert(1)>"), "kept verbatim as text");
    eq(emphasisHtml(d.msg).includes("<img"), false, "raw <img> in rendered message");
  });

  test("no diagnostic message contains an HTML tag", () => {
    const m = parsePlan(plan([{ addr: "aws_quantum.x" }, { addr: "google_thing.y" }],
                             { format_version: "9.0", errored: true }), "t");
    for (const d of m.diagnostics) eq(/<\/?[a-z]/i.test(d.msg), false, d.code + ": " + d.msg);
  });

  test("emphasisHtml turns **word** into <b>word</b> and escapes everything else", () => {
    eq(emphasisHtml("a **b** <i>c</i> & **<script>**"), "a <b>b</b> &lt;i&gt;c&lt;/i&gt; &amp; <b>&lt;script&gt;</b>");
  });
});

describe("providers: dispatch by provider, for any provider", () => {
  const registerProviders = app.fn("registerProviders");
  const getAllProviders = app.fn("getAllProviders");
  const cliCommands = app.fn("cliCommands");

  /* A small mixed plan: an AWS VPC, and a GCP network, subnetwork and VM.
     provider_name decides ownership, as terraform writes it. */
  const AWS = "registry.terraform.io/hashicorp/aws", GCP = "registry.terraform.io/hashicorp/google";
  const rc = (address, provider_name, after) => {
    const [type, name] = address.split(".");
    return { address, type, name, mode: "managed", provider_name, change: { actions: ["create"], after: after || {} } };
  };
  const cfg = (address, refs) => {
    const [type, name] = address.split(".");
    const expressions = {};
    for (const [k, r] of Object.entries(refs || {})) expressions[k] = { references: r };
    return { address, type, name, mode: "managed", expressions };
  };
  const mixed = () => ({
    format_version: "1.2",
    configuration: {
      provider_config: {
        aws: { name: "aws", expressions: { region: { constant_value: "eu-west-1" } } },
        google: { name: "google", full_name: GCP, expressions: { project: { constant_value: "demo-proj" }, region: { references: ["var.gregion"] } } }
      },
      root_module: { resources: [
        cfg("aws_vpc.main"),
        cfg("google_compute_network.net"),
        cfg("google_compute_subnetwork.sub", { network: ["google_compute_network.net.id", "google_compute_network.net"] }),
        cfg("google_compute_instance.vm", { "network_interface": [] }),
        cfg("random_id.suffix"),
        cfg("google_storage_bucket.b", { name: ["random_id.suffix.hex", "random_id.suffix"] })
      ] }
    },
    variables: { gregion: { value: "europe-west1" } },
    resource_changes: [
      rc("aws_vpc.main", AWS, { cidr_block: "10.0.0.0/16" }),
      rc("google_compute_network.net", GCP, { name: "net" }),
      rc("google_compute_subnetwork.sub", GCP, { name: "sub", ip_cidr_range: "10.1.0.0/24" }),
      rc("google_compute_instance.vm", "registry.terraform.io/hashicorp/google-beta", { name: "vm-1", zone: "europe-west1-b" }),
      rc("random_id.suffix", "registry.terraform.io/hashicorp/random"),
      rc("google_storage_bucket.b", GCP, { name: "bucket-1" })
    ]
  });
  /* the VM names its subnetwork inside a nested block */
  const withVmRef = () => {
    const p = mixed();
    p.configuration.root_module.resources[3].expressions.network_interface =
      [{ subnetwork: { references: ["google_compute_subnetwork.sub.id", "google_compute_subnetwork.sub"] } }];
    return p;
  };

  test("google resources are assigned to the google plugin by provider_name, google-beta included", () => {
    const m = parsePlan(withVmRef(), "t");
    for (const a of ["google_compute_network.net", "google_compute_subnetwork.sub", "google_compute_instance.vm"]) {
      eq(m.byAddr[a].provider, "google", a);
      eq(m.byAddr[a].supported, true, a);
    }
    eq(m.byAddr["aws_vpc.main"].provider, "aws");
    eq(m.diagnostics.filter(d => d.code === "provider" || d.code === "foreign").map(d => d.msg),
       ["**random_id** \u00d7 1 \u2014 no provider plugin draws this type yet."]);
  });

  test("references resolve between resources of any provider, not only aws_ types", () => {
    const m = parsePlan(withVmRef(), "t");
    eq(m.byAddr["google_compute_subnetwork.sub"].refs, ["google_compute_network.net"]);
    eq(m.byAddr["google_compute_instance.vm"].refs, ["google_compute_subnetwork.sub"]);
    eq(m.byAddr["google_storage_bucket.b"].refs, ["random_id.suffix"]);
  });

  test("each provider receives the settings of its own provider block", () => {
    const m = parsePlan(mixed(), "t");
    eq(m.defaultProviderSettings, { aws: { region: "eu-west-1" }, google: { project: "demo-proj", region: "europe-west1" } });
    eq(m.region, "eu-west-1", "header region is the first registered provider's");
    const vm = cliCommands(m.byAddr["google_compute_instance.vm"], m)[0].cmd;
    eq(vm, "gcloud compute instances describe vm-1 --zone europe-west1-b --project demo-proj");
    eq(cliCommands(m.byAddr["aws_vpc.main"], m)[0].cmd, "aws ec2 describe-vpcs --region eu-west-1");
  });

  test("a mixed plan is laid out as one cloud per provider, each with its own containers", () => {
    const m = parsePlan(withVmRef(), "t");
    m.resources.forEach(r => { r.enabledType = true; });
    const tree = buildTree(m, Object.assign({}, OPTS));
    eq(tree.cls, "clouds");
    eq(tree.children.map(c => c.label), ["AWS Cloud", "Google Cloud"]);
    const where = placements(m);
    eq(where["google_compute_subnetwork.sub"], "VPC net");
    eq(where["google_compute_instance.vm"], "Subnet sub 10.1.0.0/24");
    eq(where["aws_vpc.main"], "Region eu-west-1");
  });

  test("resources that use an aliased provider block receive that block's settings", () => {
    const p = mixed();
    p.configuration.provider_config["google.prod"] = { name: "google", full_name: GCP, alias: "prod",
      expressions: { project: { constant_value: "project-prod" } } };
    p.configuration.provider_config.google.expressions.project = { constant_value: "project-default" };
    p.configuration.root_module.resources.find(r => r.address === "google_compute_instance.vm").provider_config_key = "google.prod";
    p.configuration.root_module.resources.find(r => r.address === "google_compute_network.net").provider_config_key = "google";
    const m = parsePlan(p, "t");
    eq(m.byAddr["google_compute_instance.vm"].providerBlock, "google.prod");
    eq(cliCommands(m.byAddr["google_compute_instance.vm"], m)[0].cmd,
       "gcloud compute instances describe vm-1 --zone europe-west1-b --project project-prod");
    eq(cliCommands(m.byAddr["google_compute_network.net"], m)[0].cmd,
       "gcloud compute networks describe net --project project-default");
  });

  test("resources in a module receive the settings of the module's provider block", () => {
    const p = {
      format_version: "1.2",
      configuration: {
        provider_config: {
          aws: { name: "aws", full_name: AWS, expressions: { region: { constant_value: "eu-west-1" } } },
          "module.net:aws": { name: "aws", full_name: AWS, module_address: "module.net",
                              expressions: { region: { constant_value: "us-east-2" } } }
        },
        root_module: { module_calls: { net: { module: { resources: [
          Object.assign(cfg("aws_vpc.v"), { provider_config_key: "module.net:aws" }),
          Object.assign(cfg("aws_vpc.w"), { provider_config_key: "module.net.module.deep:aws" })
        ] } } } }
      },
      resource_changes: [rc("module.net.aws_vpc.v", AWS), rc("module.net.aws_vpc.w", AWS)]
    };
    p.resource_changes.forEach(c => { c.type = "aws_vpc"; c.name = c.address.split(".").pop(); c.module_address = "module.net"; });
    const m = parsePlan(p, "t");
    eq(cliCommands(m.byAddr["module.net.aws_vpc.v"], m)[0].cmd, "aws ec2 describe-vpcs --region us-east-2");
    eq(m.byAddr["module.net.aws_vpc.w"].providerBlock, "module.net:aws", "unknown nested key walks out one module");
  });

  test("a resource whose provider_name matches no plugin gets no provider's hooks", () => {
    const p = mixed();
    p.resource_changes[0].provider_name = "registry.terraform.io/someone/aws";   /* aws_vpc.main */
    const m = parsePlan(p, "t");
    const vpc = m.byAddr["aws_vpc.main"];
    eq(vpc.foreign, true);
    eq(vpc.provider, undefined);
    eq(cliCommands(vpc, m), [], "no AWS commands for a non-AWS provider");
    eq(cliCommands({ type: "aws_vpc", name: "x", attrs: {}, provider_name: "registry.terraform.io/someone/aws" }, m), [],
       "nor for a hand-built resource naming one");
  });

  test("providers are matched by full source address, not by its last part", () => {
    const byName = app.fn("getProviderForProviderName");
    eq(byName("registry.terraform.io/hashicorp/aws").id, "aws");
    eq(byName("hashicorp/aws").id, "aws");
    eq(byName("registry.opentofu.org/hashicorp/aws").id, "aws");
    eq(byName("REGISTRY.TERRAFORM.IO/HashiCorp/AWS").id, "aws");
    eq(byName("registry.terraform.io/unrelated/aws"), null);
    eq(byName("example.com/hashicorp/aws"), null);
    eq(byName("registry.terraform.io/hashicorp/google-beta").id, "google");
    eq(byName("aws").id, "aws", "a bare block name still works");
    const m = parsePlan({ format_version: "1.2", configuration: { provider_config: {
      aws: { name: "aws", full_name: "registry.terraform.io/unrelated/aws" } }, root_module: {} },
      resource_changes: [rc("aws_vpc.main", "registry.terraform.io/unrelated/aws")] }, "t");
    ok(m.diagnostics.some(d => d.code === "provider" && d.msg.includes("unrelated/aws")), "reported as unsupported");
    eq(m.byAddr["aws_vpc.main"].foreign, true);
  });

  test("a plan with one provider keeps that provider's cloud as the root", () => {
    const m = parsePlan(plan([VPC]), "t");
    m.resources.forEach(r => { r.enabledType = true; });
    eq(buildTree(m, OPTS).label, "AWS Cloud");
  });

  test("the registry refuses console hosts that are not plain hostnames, and clashing providers", () => {
    const saved = getAllProviders();
    const base = { id: "x", sourceAddresses: ["example.com/x/x"], localNames: ["x"], typePrefix: "x_", catalog: {}, categories: {}, categoryLabels: [],
                   cloudLabel: "X", cli: () => [], placement: { start: () => ({ containerOf: () => null }) } };
    const refuses = p => { try { registerProviders(saved.concat([p])); return false; } catch (e) { return true; } };
    try {
      for (const h of ["^console\\.example\\.com|console\\.other\\.com$", "console.example.com|evil.test",
                       "*.example.com", "Console.Example.com", "localhost", "console.example.com/", ""]) {
        ok(refuses(Object.assign({}, base, { consoleHosts: [{ host: h }] })), "host " + JSON.stringify(h));
      }
      ok(refuses(Object.assign({}, base, { consoleHosts: [/^console\.x\.example$/] })), "a RegExp");
      ok(refuses(Object.assign({}, base, { consoleHosts: [{ host: "console.x.example", allowRegionPrefix: "yes" }] })), "allowRegionPrefix not boolean");
      ok(refuses(Object.assign({}, base, { settingKeys: ["access_key"] })), "a credential context key");
      ok(refuses(Object.assign({}, base, { settingKeys: ["token"] })), "a token context key");
      ok(refuses(Object.assign({}, base, { categories: { a: "red;background:url(x)" } })), "a colour that is CSS");
      ok(refuses(Object.assign({}, base, { localNames: ["aws"] })), "local name already taken");
      ok(refuses(Object.assign({}, base, { sourceAddresses: ["hashicorp/aws"] })), "source already taken");
      ok(refuses(Object.assign({}, base, { sourceAddresses: ["aws"] })), "source that is not host/namespace/type");
      ok(refuses(Object.assign({}, base, { id: "aws" })), "id already taken");
      ok(!refuses(Object.assign({}, base, { consoleHosts: [{ host: "console.x.example", allowRegionPrefix: true }],
                                            settingKeys: ["region", "project"] })), "a good one is accepted");
    } finally {
      registerProviders(saved);
    }
  });

  test("a console host matches exactly, or with one region label in front when allowed", () => {
    const isDeclaredHost = app.fn("isDeclaredHost");
    const H = [{ host: "console.example.com", allowRegionPrefix: true }, { host: "portal.other.test" }];
    for (const h of ["console.example.com", "eu-west-1.console.example.com", "us-gov-west-1.console.example.com", "portal.other.test"])
      ok(isDeclaredHost(h, H), "accepts " + h);
    for (const h of ["console.example.com.attacker.test", "evilconsole.example.com", "x.console.example.com",
                     "eu-west-1.eu-west-1.console.example.com", "eu-west-1.portal.other.test", "example.com", "attacker.test"])
      eq(isDeclaredHost(h, H), false, "rejects " + h);
  });
});

describe("security: plan addresses that are prototype names", () => {
  test("resources and references named __proto__ or constructor are parsed and laid out", () => {
    const q = plan([{ addr: "aws_vpc.main" }, { addr: "aws_subnet.constructor", refs: { vpc_id: ["aws_vpc.main.id"] } }]);
    q.resource_changes.push({ address: "__proto__", type: "__proto__", name: "x", mode: "managed", change: { actions: ["create"], after: {} } });
    q.configuration.root_module.resources.push({ address: "aws_instance.i", type: "aws_instance", name: "i", mode: "managed",
      expressions: { a: { references: ["constructor", "__proto__", "aws_subnet.constructor.id"] } } });
    q.resource_changes.push({ address: "aws_instance.i", type: "aws_instance", name: "i", mode: "managed", change: { actions: ["create"], after: {} } });
    const m = parsePlan(q, "t");
    eq(Object.getPrototypeOf(m.byAddr), null);
    ok(m.byAddr["__proto__"] && m.byAddr["__proto__"].addr === "__proto__", "kept as a resource");
    m.resources.forEach(r => { r.enabledType = true; });
    const where = placements(m);
    ok(where["aws_instance.i"], "laid out");
  });
});

describe("providers: placement goes through a checked, read-only API", () => {
  const registerProviders = app.fn("registerProviders");
  const getAllProviders = app.fn("getAllProviders");

  /* A throwaway provider whose placement we control. */
  function withFake(start, fn) {
    const saved = getAllProviders();
    const fake = { id: "fake", sourceAddresses: ["example.com/test/fake"], localNames: ["fake"], typePrefix: "fake_", cloudLabel: "Fake Cloud",
      catalog: { fake_net: { kind: "group", label: "Net", icon: "i-vpc", cat: "net" },
                 fake_vm: { kind: "node", label: "VM", icon: "i-ec2", cat: "compute" } },
      categories: {}, categoryLabels: [], cli: () => [], placement: { start } };
    registerProviders(saved.concat([fake]));
    try { return fn(); } finally { registerProviders(saved); }
  }
  const fakePlan = () => plan([{ addr: "fake_net.n" }, { addr: "fake_vm.v", refs: { net: ["fake_net.n.id"] } }]);
  const layout = () => {
    const m = parsePlan(fakePlan(), "t");
    m.resources.forEach(r => { r.enabledType = true; });
    return { m, where: placements(m) };
  };

  test("a provider places resources by returning container references", () => withFake(api => {
    const net = api.addContainer(api.region, { cls: "vpc", label: "Net n", resource: "fake_net.n" });
    return { containerOf: a => (a === "fake_vm.v" ? net : null) };
  }, () => {
    eq(layout().where["fake_vm.v"], "Net n");
  }));

  test("the resources it reads are frozen copies", () => withFake(api => {
    "use strict";   /* as provider code always is: writes to frozen objects throw */
    const r = api.resources[0];
    const attempts = [() => { r.attrs.x = 1; }, () => { r.refs.push("y"); }, () => { api.resources.push({}); },
                      () => { api.defaultSettings.region = "x"; }, () => { api.addContainer = null; }];
    attempts.forEach(f => { try { f(); } catch (e) { /* expected */ } });
    if (r.attrs.x !== undefined || r.refs.includes("y") || api.resources.length !== 2 ||
        api.defaultSettings.region === "x" || typeof api.addContainer !== "function") throw new Error("a write went through");
    if (!Object.isFrozen(r) || !Object.isFrozen(r.attrs) || !Object.isFrozen(api)) throw new Error("not frozen");
    return { containerOf: () => null };
  }, () => {
    const { m } = layout();
    eq(m.diagnostics.some(d => d.code === "placement-fake"), false, "no placement error");
    eq(m.byAddr["fake_net.n"].attrs.x, undefined);
  }));

  for (const [name, bad] of Object.entries({
    "uses an unknown parent":                api => api.addContainer("nope", { cls: "vpc", label: "x" }),
    "uses a class that is not lower-case words": api => api.addContainer(api.region, { cls: "vpc\" onclick=\"x", label: "x" }),
    "uses a class reserved for core":        api => api.addContainer(api.region, { cls: "cloud", label: "x" }),
    "passes a label that is not a string":   api => api.addContainer(api.region, { cls: "vpc", label: { toString: () => "<b>" } }),
    "names another provider's resource":     api => api.addContainer(api.region, { cls: "vpc", label: "x", resource: "aws_vpc.main" }),
    "sets a width out of range":             api => api.addContainer(api.region, { cls: "vpc", label: "x", maxW: 1e9 }),
    "throws":                                () => { throw new Error("boom"); }
  })) {
    test(`placement that ${name}: reported, its boxes discarded, every resource drawn`, () => withFake(api => {
      api.addContainer(api.region, { cls: "vpc", label: "Net n", resource: "fake_net.n" });
      bad(api);
      return { containerOf: () => null };
    }, () => {
      const { m, where } = layout();
      ok(m.diagnostics.some(d => d.code === "placement-fake" && d.level === "err"), "placement-fake diagnostic");
      /* its boxes are dropped, and both resources still show, as tiles */
      eq(Object.keys(where).sort(), ["fake_net.n", "fake_vm.v"]);
    }));
  }

  for (const handle of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    test(`a containerOf answer of "${handle}" is reported and not used`, () => withFake(api => {
      api.addContainer(api.region, { cls: "vpc", label: "Net n", resource: "fake_net.n" });
      return { containerOf: () => handle };
    }, () => {
      const { m, where } = layout();
      ok(m.diagnostics.some(d => d.code === "placement-fake"), "placement-fake diagnostic");
      eq(Object.keys(where).sort(), ["fake_net.n", "fake_vm.v"]);
    }));
  }

  test("addContainer refuses an inherited property name as resource", () => withFake(api => {
    api.addContainer(api.region, { cls: "vpc", label: "x", resource: "constructor" });
    return { containerOf: () => null };
  }, () => {
    ok(layout().m.diagnostics.some(d => d.code === "placement-fake"), "placement-fake diagnostic");
  }));

  test("a failure after start() discards the provider's boxes, and every resource is still drawn", () => {
    let calls = 0;
    withFake(api => {
      const net = api.addContainer(api.region, { cls: "vpc", label: "Net n", resource: "fake_net.n" });
      return { containerOf: () => { if (++calls > 0) throw new Error("late"); return net; } };
    }, () => {
      const m = parsePlan(fakePlan(), "t");
      m.resources.forEach(r => { r.enabledType = true; });
      const tree = buildTree(m, OPTS);
      const boxes = [], tiles = [];
      (function walk(g) { if (g.box) { boxes.push(g.cls); g.children.forEach(walk); } else tiles.push(g.res.addr); })(tree);
      ok(m.diagnostics.some(d => d.code === "placement-fake" && /late/.test(d.msg)), "late failure reported");
      eq(boxes.includes("vpc"), false, "none of the provider's boxes survive");
      eq(tiles.sort(), ["fake_net.n", "fake_vm.v"], "the group resource too, as a tile");
    });
  });

  test("a group-kind resource that no box draws is drawn as a tile", () => withFake(() => {
    return { containerOf: () => null };
  }, () => {
    const { where } = layout();
    eq(Object.keys(where).sort(), ["fake_net.n", "fake_vm.v"], "fake_net is a group type, drawn as a tile");
  }));

  test("placement receives each resource's provider-block settings through settingsOf", () => {
    const seen = {};
    withFake(api => {
      api.resources.forEach(r => { seen[r.addr] = api.settingsOf(r.addr); });
      seen.unknown = api.settingsOf("nope.x");
      ok(Object.isFrozen(seen["fake_vm.v"]), "frozen");
      return { containerOf: () => null };
    }, () => {
      const q = fakePlan();
      q.configuration.provider_config = { fake: { name: "fake", expressions: {} },
                                          "fake.eu": { name: "fake", alias: "eu", expressions: { region: { constant_value: "eu-1" } } } };
      q.configuration.root_module.resources.find(r => r.address === "fake_vm.v").provider_config_key = "fake.eu";
      const saved = getAllProviders();
      const fake = saved.find(x => x.id === "fake");
      registerProviders(saved.filter(x => x.id !== "fake").concat([Object.assign({}, fake, { settingKeys: ["region"] })]));
      try {
        const m = parsePlan(q, "t");
        m.resources.forEach(r => { r.enabledType = true; });
        buildTree(m, OPTS);
      } finally { registerProviders(saved); }
      eq(seen["fake_vm.v"], { region: "eu-1" });
      eq(seen["fake_net.n"], {});
      eq(seen.unknown, {});
    });
  });

  test("a containerOf answer that is not a known reference is reported and not used", () => withFake(api => {
    return { containerOf: () => "c999" };
  }, () => {
    const { m, where } = layout();
    ok(m.diagnostics.some(d => d.code === "placement-fake"), "placement-fake diagnostic");
    ok(where["fake_vm.v"], "vm still drawn");
  }));
});

describe("security: sensitive values are redacted in the parser", () => {
  const changedKeys = app.fn("changedKeys");
  const changeHtml = app.fn("changeHtml");
  const hclFor = app.fn("hclFor");
  const frozenProviderResource = app.fn("frozenProviderResource");
  const cliCommands = app.fn("cliCommands");
  const SECRET = "hunter2-secret";
  const noSecret = (v, what) => eq(JSON.stringify(v).includes(SECRET), false, what + " holds the secret");

  const p = () => ({
    format_version: "1.2",
    variables: { db_password: { value: SECRET }, env: { value: "prod" } },
    configuration: {
      provider_config: { aws: { name: "aws", expressions: { region: { constant_value: "eu-west-1" } } } },
      root_module: {
        variables: { db_password: { sensitive: true }, env: {} },
        resources: [
          { address: "aws_db_instance.old", type: "aws_db_instance", name: "old", mode: "managed",
            expressions: { password: { constant_value: SECRET }, identifier: { constant_value: "db1" } } },
          { address: "aws_db_instance.upd", type: "aws_db_instance", name: "upd", mode: "managed",
            expressions: { password: { references: ["var.db_password"] } } },
          { address: "aws_instance.web", type: "aws_instance", name: "web", mode: "managed",
            expressions: { tags: { constant_value: { Name: SECRET, team: "a" } } } }
        ]
      }
    },
    resource_changes: [
      /* destroyed: the secret is only marked in before_sensitive */
      { address: "aws_db_instance.old", type: "aws_db_instance", name: "old", mode: "managed",
        change: { actions: ["delete"], before: { identifier: "db1", password: SECRET }, after: null,
                  before_sensitive: { password: true }, after_sensitive: false } },
      /* updated: the secret changed, both sides marked */
      { address: "aws_db_instance.upd", type: "aws_db_instance", name: "upd", mode: "managed",
        change: { actions: ["update"], before: { identifier: "db2", password: SECRET + "-old" },
                  after: { identifier: "db2", password: SECRET },
                  before_sensitive: { password: true }, after_sensitive: { password: true } } },
      /* a secret one leaf deep, inside a map */
      { address: "aws_instance.web", type: "aws_instance", name: "web", mode: "managed",
        change: { actions: ["create"], before: null, after: { tags: { Name: SECRET, team: "a" } },
                  after_sensitive: { tags: { Name: true } } } }
    ],
    output_changes: { pw: { actions: ["create"], after: SECRET, after_sensitive: true },
                      conn: { actions: ["create"], after: { user: "u", pass: SECRET }, after_sensitive: { pass: true } } },
    resource_drift: [{ address: "aws_db_instance.upd", type: "aws_db_instance", name: "upd",
      change: { before: { password: SECRET }, after: { password: SECRET + "x" }, before_sensitive: { password: true } } }]
  });

  test("resources, variables, outputs and drift in the model contain no sensitive value", () => {
    const m = parsePlan(p(), "t");
    noSecret(m.resources.map(r => [r.attrs, r.before]), "resources");
    noSecret(m.variables, "variables");
    noSecret(m.outputs, "outputs");
    noSecret(m.driftDetails, "drift");
    eq(m.variables.env, "prod", "a variable that is not sensitive is kept");
    eq(m.byAddr["aws_instance.web"].attrs.tags, { Name: "(sensitive value)", team: "a" }, "only the marked leaf goes");
  });

  test("a deleted resource marked only in before_sensitive is redacted", () => {
    const r = parsePlan(p(), "t").byAddr["aws_db_instance.old"];
    eq(r.before.password, "(sensitive value)");
    eq(r.attrs.password, "(sensitive value)");
    noSecret(changeHtml(r), "the destroy diff");
  });

  test("a changed sensitive value is listed as changed, without its value", () => {
    const r = parsePlan(p(), "t").byAddr["aws_db_instance.upd"];
    eq(changedKeys(r), ["password"]);
    const d = changeHtml(r);
    ok(d && d.count === 1 && d.body.includes("(sensitive value)"), "one masked diff row");
    noSecret(d, "the update diff");
  });

  test("reconstructed HCL replaces literals of sensitive attributes", () => {
    const m = parsePlan(p(), "t");
    for (const a of ["aws_db_instance.old", "aws_instance.web"]) {
      const h = hclFor(m.byAddr[a], m.cfgByAddr[a]);
      ok(h && h.includes("(sensitive value)"), a + " shows the marker");
      noSecret(h, a + " HCL");
    }
    ok(hclFor(m.byAddr["aws_db_instance.old"], m.cfgByAddr["aws_db_instance.old"]).includes('identifier = "db1"'),
       "other literals are kept");
  });

  test("a resource marked sensitive as a whole (mask true) is redacted in attrs, before, diff and HCL", () => {
    const q = p();
    q.resource_changes[1].change.after_sensitive = true;      /* aws_db_instance.upd */
    q.resource_changes[1].change.before_sensitive = true;
    q.configuration.root_module.resources[1].expressions = {
      password: { constant_value: SECRET }, master_note: { constant_value: SECRET } };   /* a key not in the values */
    const m = parsePlan(q, "t");
    const r = m.byAddr["aws_db_instance.upd"];
    eq(typeof r.attrs, "object", "attrs keep their shape");
    eq(r.attrs.identifier, "(sensitive value)");
    noSecret([r.attrs, r.before, changeHtml(r)], "the resource");
    const h = hclFor(r, m.cfgByAddr["aws_db_instance.upd"]);
    ok(h.includes("password = (sensitive value)") && h.includes("master_note = (sensitive value)"), "every config literal masked");
    noSecret(h, "HCL");
  });

  test("a plan key named __proto__ stays an ordinary property and is redacted", () => {
    const q = p();
    q.resource_changes[2].change.after = JSON.parse('{"tags": {"__proto__": {"Name": "' + SECRET + '"}, "team": "a"}}');
    q.resource_changes[2].change.after_sensitive = JSON.parse('{"tags": {"__proto__": {"Name": true}}}');
    const r = parsePlan(q, "t").byAddr["aws_instance.web"];
    eq(Object.getPrototypeOf(r.attrs.tags), Object.prototype, "prototype unchanged");
    ok(Object.prototype.hasOwnProperty.call(r.attrs.tags, "__proto__"), "kept as an own property");
    noSecret(r.attrs, "attrs");
  });

  test("a provider setting whose value comes from a sensitive variable is not passed to the provider", () => {
    const m = parsePlan({
      format_version: "1.2",
      variables: { credential: { value: SECRET }, proj: { value: "visible-proj" } },
      configuration: {
        provider_config: { google: { name: "google", full_name: "registry.terraform.io/hashicorp/google",
          expressions: { project: { references: ["var.credential"] }, region: { references: ["var.proj"] } } } },
        root_module: { variables: { credential: { sensitive: true }, proj: {} },
          resources: [{ address: "google_compute_network.n", type: "google_compute_network", name: "n", mode: "managed", expressions: {} }] }
      },
      resource_changes: [{ address: "google_compute_network.n", type: "google_compute_network", name: "n", mode: "managed",
        provider_name: "registry.terraform.io/hashicorp/google", change: { actions: ["create"], after: { name: "n" } } }]
    }, "t");
    eq(m.variables.credential, "(sensitive value)");
    eq(m.defaultProviderSettings.google, { region: "visible-proj" }, "the sensitive setting is left out");
    noSecret([m.defaultProviderSettings, m.providerBlocks, cliCommands(m.byAddr["google_compute_network.n"], m)], "provider context and commands");
  });

  test("a nested block element marked sensitive as a whole is redacted in HCL", () => {
    const q = p();
    q.resource_changes[2].change.after.root_block_device = [{ kms_key_id: SECRET, size: 8 }, { kms_key_id: "k2", size: 9 }];
    q.resource_changes[2].change.after_sensitive.root_block_device = [true, { kms_key_id: true }];
    q.configuration.root_module.resources[2].expressions.root_block_device = [
      { kms_key_id: { constant_value: SECRET }, size: { constant_value: 8 } },
      { kms_key_id: { constant_value: SECRET + "-2" }, size: { constant_value: 9 } }];
    const m = parsePlan(q, "t");
    const h = hclFor(m.byAddr["aws_instance.web"], m.cfgByAddr["aws_instance.web"]);
    noSecret(h, "HCL");
    ok(/size = \(sensitive value\)/.test(h), "the whole first element is masked");
    ok(h.includes("size = 9"), "the second element keeps its plain field");
    noSecret(m.cfgByAddr, "the configuration the UI reads");
  });

  test("provider inputs and generated commands contain no sensitive value", () => {
    const m = parsePlan(p(), "t");
    noSecret(m.resources.map(frozenProviderResource), "provider input");
    noSecret(m.resources.map(r => cliCommands(r, m)), "CLI commands");
  });
});

describe("sdk: referencedValues and singleReferencedValue", () => {
  const referencedValues = app.fn("referencedValues"), singleReferencedValue = app.fn("singleReferencedValue");
  const boxes = { "x_subnet.a[0]": "A0", "x_subnet.a[1]": "A1", "x_subnet.b": "B" };

  test("a specific instance wins over the base form Terraform lists beside it", () => {
    eq(referencedValues(boxes, ["x_subnet.a[0]", "x_subnet.a"]), ["A0"]);
    eq(singleReferencedValue(boxes, ["x_subnet.a[0]", "x_subnet.a"]), "A0");
  });
  test("a bare base with no specific form is a splat over every instance", () => {
    eq(referencedValues(boxes, ["x_subnet.a"]), ["A0", "A1"]);
    eq(singleReferencedValue(boxes, ["x_subnet.a"]), null, "ambiguous");
  });
  test("each match is returned once; unknown references and inherited names match nothing", () => {
    eq(referencedValues(boxes, ["x_subnet.b", "x_subnet.b", "x_other.c", "constructor", "__proto__", "toString"]), ["B"]);
    eq(singleReferencedValue(boxes, []), null);
  });
});

describe("providers: hooks receive frozen input; a failing hook is skipped and reported", () => {
  const registerProviders = app.fn("registerProviders");
  const getAllProviders = app.fn("getAllProviders");
  const cliCommands = app.fn("cliCommands"), consoleLink = app.fn("consoleLink"), tileSubtitleFor = app.fn("tileSubtitleFor");
  const blockHeight = app.fn("blockHeight"), rulesSection = app.fn("rulesSection"), ruleKey = app.fn("ruleKey");
  const setLinksEnabled = app.fn("setLinksEnabled");
  const seen = [];

  const BAD = {
    id: "bad", name: "Bad", sourceAddresses: ["example.com/test/bad"], localNames: ["bad"], typePrefix: "bad_", cloudLabel: "Bad",
    catalog: { bad_fw: { kind: "node", label: "Firewall", icon: "i-sg", cat: "net", sub: "name" } },
    categories: { net: "var(--cat-net)" }, categoryLabels: [["net", "Networking"]],
    consoleHosts: [{ host: "console.bad.example" }],
    cli: r => { "use strict"; seen.push(Object.isFrozen(r) && Object.isFrozen(r.attrs));
                try { r.action = "no-op"; } catch (e) {} try { r.attrs.name = "changed"; } catch (e) {}
                return [{ label: "Describe", argv: ["bad", 42] }]; },
    consoleUrl: () => { throw new Error("console broke"); },
    tileSubtitle: () => ({ toString: () => "<b>x</b>" }),
    sizing: { blockHeight: () => 1e9 },
    rules: {
      ruleSet: () => ({ title: "Rules", name: "fw", ordered: false, note: "n", directions: [{ attr: "rules", inbound: true, peerHeading: "Source" }] }),
      describe: e => { if (e && e.boom) throw new Error("describe broke"); return { ports: 1, service: "", protocol: "", peer: "" }; },
      key: () => ({})
    },
    placement: { start: () => ({ containerOf: () => null }) }
  };

  test("writes by hooks do not change the model; each failing hook is skipped and reported once", () => {
    const saved = getAllProviders();
    registerProviders(saved.concat([BAD]));
    try {
      const m = parsePlan(plan([{ addr: "bad_fw.f", after: { name: "fw-1", rules: [{ port: 22 }, { boom: true }] }, actions: ["delete"] }]), "t");
      const r = m.byAddr["bad_fw.f"];
      eq(cliCommands(r, m), [], "invalid commands dropped");
      eq(seen, [true], "cli got a frozen resource");
      eq(r.action, "delete", "action unchanged");
      eq(r.attrs.name, "fw-1", "attrs unchanged");
      setLinksEnabled(true);
      try { eq(consoleLink(r, m), null, "a throwing consoleUrl gives no link"); } finally { setLinksEnabled(false); }
      eq(tileSubtitleFor(r, "fw-1"), "fw-1", "a non-text tileSubtitle falls back to the value");
      eq(blockHeight(r), 26, "an absurd height falls back");
      const sec = rulesSection(r);
      ok(sec && sec.body.includes("rules-cap"), "rules still drawn with fallbacks");
      eq(typeof ruleKey(r, { port: 22 }), "string");
      const codes = m.diagnostics.map(d => d.code).filter(c => c.startsWith("provider-bad-")).sort();
      eq(codes, ["provider-bad-cli", "provider-bad-consoleUrl"], "reported into the model passed in");
    } finally {
      registerProviders(saved);
    }
  });
});

describe("providers: icons are path data from which core builds SVG", () => {
  const registerProviders = app.fn("registerProviders");
  const getAllProviders = app.fn("getAllProviders");
  const catalogEntry = app.fn("catalogEntry");
  const addProviderIconSymbols = app.fn("addProviderIconSymbols");
  const { JSDOM } = require("jsdom");
  const base = { id: "ico", name: "Ico", sourceAddresses: ["example.com/test/ico"], localNames: ["ico"], typePrefix: "ico_",
    cloudLabel: "Ico", categories: {}, categoryLabels: [], cli: () => [],
    placement: { start: () => ({ containerOf: () => null }) },
    icons: { box: { grid: 64, paths: ["M8 8 L56 8 L56 56 Z"] } },
    catalog: { ico_box: { kind: "node", label: "Box", icon: "box" }, ico_vpc: { kind: "node", label: "V", icon: "i-vpc" } } };
  const withIco = (p, fn) => {
    const saved = getAllProviders();
    try { registerProviders(saved.concat([p])); return fn(); } finally { registerProviders(saved); }
  };
  const refuses = p => { try { withIco(p, () => {}); return false; } catch (e) { return true; } };

  test("icon data other than SVG path data is refused at registration", () => {
    for (const bad of ['M0 0"/><script>x</script>', "M0 0 url(#x)", "M0 0 <", "M0 0;fill:red", "", "x".repeat(9000)])
      ok(refuses(Object.assign({}, base, { icons: { box: { paths: [bad] } } })), "path " + JSON.stringify(bad.slice(0, 30)));
    ok(refuses(Object.assign({}, base, { icons: { "i-box": { paths: ["M0 0"] } } })), "a key that looks like a shared symbol");
    ok(refuses(Object.assign({}, base, { icons: { box: { grid: 32, paths: ["M0 0"] } } })), "an unknown grid");
    ok(refuses(Object.assign({}, base, { catalog: { ico_x: { kind: "node", label: "X", icon: "nope" } } })), "a catalog icon that exists nowhere");
    ok(!refuses(base), "a good one is accepted");
  });

  test("catalogEntry replaces a provider's icon key with its symbol id and keeps shared ids", () => withIco(base, () => {
    const p = getAllProviders().find(x => x.id === "ico");
    eq(catalogEntry("ico_box", p).icon, "p-ico-box");
    eq(catalogEntry("ico_vpc", p).icon, "i-vpc");
    eq(p.catalog.ico_box.icon, "box", "the provider's own catalog is not changed");
  }));

  test("the symbol is built with DOM calls, with the validated path data as the only provider value", () => withIco(base, () => {
    const dom = new JSDOM('<svg><defs><symbol id="i-vpc"></symbol></defs></svg>');
    const doc = dom.window.document;
    ok(addProviderIconSymbols(doc) >= 1, "mounted");
    const sym = doc.getElementById("p-ico-box");
    ok(sym && sym.parentNode === doc.querySelector("defs"), "beside the shared symbols");
    eq(sym.outerHTML, '<symbol id="p-ico-box" viewBox="0 0 48 48"><rect width="48" height="48" rx="9" fill="currentColor"></rect>' +
                      '<g transform="scale(0.75)"><path fill="#fff" d="M8 8 L56 8 L56 56 Z"></path></g></symbol>');
    eq(addProviderIconSymbols(doc), 0, "mounting twice adds nothing");
  }));
});

/* ---- provider contract ------------------------------------------------
   Every registered provider, plus a minimal fake one, must pass these. A new
   provider is ready for review when it does. */
describe("providers: contract", () => {
  const fs = require("fs");
  const registerProviders = app.fn("registerProviders");
  const getAllProviders = app.fn("getAllProviders");
  const safeExternalUrl = app.fn("safeExternalUrl");
  const cliCommands = app.fn("cliCommands");
  const ICONS = new Set([...fs.readFileSync(require("path").join(__dirname, "..", "src", "index.html"), "utf8")
    .matchAll(/<symbol[^>]*\bid="(i-[a-z0-9-]+)"/g)].map(m => m[1]));
  const HOSTILE = "$(printf INJECTED)<img src=x onerror=1>\"'`;|&";

  /* the smallest provider that passes: data, one container, nothing else */
  const FAKE = {
    id: "fake", name: "Fake", sourceAddresses: ["example.com/test/fake"], localNames: ["fake"], typePrefix: "fake_",
    cloudLabel: "Fake Cloud",
    icons: { "fake-vm": { paths: ["M12 12 H36 V36 H12 Z", "M18 18 h12 v12 h-12 z"] } },
    catalog: { fake_net: { kind: "group", label: "Net", icon: "i-vpc", cat: "net" },
               fake_vm:  { kind: "node", label: "VM", icon: "fake-vm", cat: "net", scope: "network" } },
    categories: { net: "var(--cat-net)" }, categoryLabels: [["net", "Networking"]],
    cli: (r) => [{ label: "Describe", argv: ["fake", "show", String((r.attrs || {}).name || "<name>")] }],
    placement: { start: api => {
      const box = {};
      api.resources.forEach(r => { if (r.type === "fake_net") box[r.addr] = api.addContainer(api.region, { cls: "vpc", label: r.name, resource: r.addr }); });
      return { containerOf: a => { const r = api.resources.find(x => x.addr === a); return r ? (r.refs.map(x => box[x]).find(Boolean) || null) : null; } };
    } }
  };

  /* one resource per catalog type, every string attribute hostile, the
     first group-kind type referenced by everything else */
  function planFor(pr) {
    const types = Object.keys(pr.catalog);
    const group = types.find(t => pr.catalog[t].kind === "group");
    const source = pr.sourceAddresses[0];
    const rcs = types.map(t => ({ address: t + ".x", type: t, name: "x", mode: "managed", provider_name: source,
      change: { actions: ["update"], before: { name: "old", id: "id-1" },
                after: { name: HOSTILE, id: HOSTILE, tags: { Name: HOSTILE }, ingress: [{ description: HOSTILE }] } } }));
    const cfgs = types.map(t => ({ address: t + ".x", type: t, name: "x", mode: "managed",
      expressions: (group && t !== group) ? { parent: { references: [group + ".x.id", group + ".x"] } } : {} }));
    return { format_version: "1.2", resource_changes: rcs,
             configuration: { provider_config: { [pr.localNames[0]]: { name: pr.localNames[0], full_name: source,
               expressions: Object.fromEntries((pr.settingKeys || []).map(k => [k, { constant_value: HOSTILE }])) } },
               root_module: { resources: cfgs } } };
  }

  function contract(pr) {
    test(`${pr.id}: identity and catalog are valid, JSON-serialisable data`, () => {
      ok(/^[a-z][a-z0-9-]*$/.test(pr.id), "id");
      ok(pr.sourceAddresses.length && pr.sourceAddresses.every(s => s.split("/").length === 3), "sourceAddresses are host/namespace/type");
      ok(pr.localNames.length && pr.typePrefix && typeof pr.cloudLabel === "string", "names, prefix, cloudLabel");
      eq(JSON.parse(JSON.stringify(pr.catalog)), pr.catalog, "catalog survives a JSON round trip");
      for (const [t, e] of Object.entries(pr.catalog)) {
        ok(t.startsWith(pr.typePrefix), t + " starts with " + pr.typePrefix);
        ok(["node", "group", "assoc"].includes(e.kind), t + " kind");
        ok(typeof e.label === "string" && e.label, t + " label");
        ok(ICONS.has(e.icon) || (pr.icons && Object.prototype.hasOwnProperty.call(pr.icons, e.icon)),
           t + " icon " + e.icon + " is a shared symbol in index.html or one of the provider's own");
        ok(!e.cat || pr.categories[e.cat], t + " category " + e.cat + " is declared");
        ok(e.scope === undefined || ["global", "region", "network"].includes(e.scope), t + " scope");
        ok(e.preview === undefined || (Array.isArray(e.preview) && e.preview.every(k => typeof k === "string")), t + " preview");
      }
      for (const [c] of pr.categoryLabels) ok(c === "other" || pr.categories[c], "label for undeclared category " + c);
    });

    test(`${pr.id}: a plan with hostile values in every attribute is parsed, laid out and described without errors`, () => {
      const m = parsePlan(planFor(pr), "t");
      m.resources.forEach(r => { r.enabledType = true; });
      for (const r of m.resources) eq(r.provider, pr.id, r.addr + " owner");
      const a = JSON.stringify(buildTree(m, OPTS)), b = JSON.stringify(buildTree(m, OPTS));
      eq(m.diagnostics.filter(d => d.code.startsWith("placement-")).map(d => d.msg), [], "placement problems");
      ok(a === b, "the same plan lays out the same way twice");
      const drawn = new Set();
      (function walk(g) { if (g.res) drawn.add(g.res.addr); if (g.box) g.children.forEach(walk); })(JSON.parse(a));
      eq(m.resources.map(r => r.addr).filter(x => !drawn.has(x)), [], "every resource is in the diagram");
      for (const r of m.resources) {
        for (const c of cliCommands(r, m)) ok(typeof c.cmd === "string" && typeof c.label === "string", r.addr + " command");
        if (pr.consoleUrl) {
          const u = pr.consoleUrl(r, { region: "eu-west-1" });
          ok(u === null || safeExternalUrl(u, pr.consoleHosts || []) !== null, r.addr + " console link is on a declared host: " + u);
        }
        if (pr.rules && pr.rules.ruleSet(r)) {
          const t = pr.rules.describe({ description: HOSTILE });
          ok(["ports", "service", "protocol", "peer"].every(k => typeof t[k] === "string"), r.addr + " rule text");
          ok(typeof pr.rules.key({}) === "string", r.addr + " rule key");
        }
        if (pr.tileSubtitle) ok(typeof pr.tileSubtitle(r, HOSTILE) === "string", r.addr + " tileSubtitle");
      }
    });
  }

  for (const pr of getAllProviders()) contract(pr);

  const saved = getAllProviders();
  registerProviders(saved.concat([FAKE]));
  try { contract(FAKE); } finally { registerProviders(saved); }
});

describe("tools: make-kinds records each provider's version", () => {
  const os = require("os"), fs = require("fs"), path = require("path");
  const { spawnSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfview-kinds-"));
  const schema = path.join(dir, "schema.json"), lock = path.join(dir, "lock.hcl"), out = path.join(dir, "out.json");
  const AWS = "registry.terraform.io/hashicorp/aws", GCP = "registry.terraform.io/hashicorp/google";
  fs.writeFileSync(schema, JSON.stringify({ format_version: "1.0", provider_schemas: {
    [AWS]: { resource_schemas: { aws_vpc: { block: { attributes: { tags: { type: ["map", "string"] } } } } } },
    [GCP]: { resource_schemas: { google_compute_instance: { block: { block_types: { network_interface: { nesting_mode: "list" } } } } } }
  } }));
  fs.writeFileSync(lock, `provider "${AWS}" {\n  version     = "5.100.0"\n  hashes = ["h1:x"]\n}\n\nprovider "${GCP}" {\n  version = "6.10.0"\n}\n`);
  const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, "make-kinds.js"), schema, ...a, "-o", out], { encoding: "utf8" });

  try {
    test("versions come from the lock file, one per provider", () => {
      eq(run("--lock", lock).status, 0);
      const k = JSON.parse(fs.readFileSync(out, "utf8"));
      eq(k.meta.providers.aws.version, "5.100.0");
      eq(k.meta.providers.google.version, "6.10.0");
      eq(k.kinds.aws_vpc, { tags: "m" });
      eq(k.kinds.google_compute_instance, { network_interface: "l" });
    });
    test("--version name=X sets one provider's version", () => {
      eq(run("--lock", lock, "--version", "google=6.11.0").status, 0);
      eq(JSON.parse(fs.readFileSync(out, "utf8")).meta.providers.google.version, "6.11.0");
    });
    test("a bare --version for several providers, or a missing version, is refused", () => {
      eq(run("--version", "5.100.0").status, 2);
      eq(run("--version", "aws=5.100.0").status, 2, "google has none");
      eq(run("--lock", lock, "--version", "azurerm=1.0.0").status, 2, "unknown provider name");
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---- report ---------------------------------------------------------- */

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
