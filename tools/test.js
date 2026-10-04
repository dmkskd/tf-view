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

  test("a non-aws provider is reported, not drawn", () => {
    const m = parsePlan(plan([{ addr: "google_compute_network.x" }]), "t");
    eq(m.resources[0].foreign, true);
    ok(m.diagnostics.some(d => d.code === "no-aws"), "no-aws diagnostic");
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

  test("data sources and unknown addresses are ignored", () => {
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

/* ---- report ---------------------------------------------------------- */

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
