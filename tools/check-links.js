// check-links.js — checks the validation of links built from plan data.
//
// WHAT IT CHECKS
//   1. safeExternalUrl accepts only https URLs on the hosts the provider
//      declares (here the AWS console hosts) and rejects everything else,
//      including hostile lookalikes; with no declared hosts it links nowhere.
//   2. Links are off until enabled, and a plan cannot turn them on.
//   3. A hostile plan (region, id and name chosen by an attacker) yields an
//      AWS console URL or nothing.
//   4. No source file outside the allowed ones opens a window, assigns a
//      location, or builds an href from a variable, so a new link cannot
//      bypass the guard unnoticed.
//
// HOW TO USE IT
//   node tools/check-links.js         exits non-zero on the first failure

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "src", "ts");

function loadModule(rel, shims) {
  const code = ts.transpileModule(fs.readFileSync(path.join(SRC, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const m = { exports: {} };
  /* a provider's only import is the SDK; its runtime part is the value readers */
  const req = spec => (/sdk\/index\.js$/.test(spec) ? loadModule("sdk/values.ts") : {});
  new Function("module", "exports", "require", ...Object.keys(shims || {}), code)(
    m, m.exports, req, ...Object.values(shims || {}));
  return m.exports;
}

const store = {};
const localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); }
};
const links = loadModule("core/links.ts", { localStorage });
const { awsConsoleUrl, AWS_CONSOLE_HOSTS: H } = loadModule("providers/aws/console.ts");

let fail = 0;
function check(name, cond) {
  if (!cond) { fail++; console.log("  FAIL " + name); } else console.log("  ok   " + name);
}

/* ---- 1. the allowlist ------------------------------------------------ */
const good = [
  "https://console.aws.amazon.com/iam/home#/roles/details/x",
  "https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#InstanceDetails:instanceId=i-1",
  "https://cn-north-1.console.amazonaws.cn/ec2/home",
  "https://us-gov-west-1.console.amazonaws-us-gov.com/ec2/home"
];
const bad = [
  "http://console.aws.amazon.com/",
  "https://evil.com/",
  "https://console.aws.amazon.com.evil.com/",
  "https://evil.com/console.aws.amazon.com",
  "https://evilconsole.aws.amazon.com/",
  "https://x.console.aws.amazon.com/",
  "https://user:pw@console.aws.amazon.com/",
  "https://console.aws.amazon.com:8443/",
  "https://eu-west-1.console.aws.amazon.com@evil.com/",
  "javascript:alert(1)",
  "data:text/html,x",
  "//console.aws.amazon.com/",
  "console.aws.amazon.com",
  "https://console.aws.amazon.com/" + "a".repeat(2100),
  "", null, undefined, 42, {}
];
good.forEach(u => check("accepts " + u.slice(0, 60), links.safeExternalUrl(u, H) !== null));
bad.forEach(u => check("rejects " + String(u).slice(0, 60), links.safeExternalUrl(u, H) === null));

/* a backslash is read as a slash, so this stays on the AWS host */
check("backslash trick resolves to the AWS host",
  new URL(links.safeExternalUrl("https://eu-west-1.console.aws.amazon.com\\@evil.com/", H)).hostname === "eu-west-1.console.aws.amazon.com");

check("a provider that declares no hosts links nowhere",
  links.safeExternalUrl(good[0], []) === null && links.safeExternalUrl(good[0]) === null);

/* ---- 2. off by default, not controlled by a plan --------------------- */
check("links are off by default", links.linksEnabled() === false);
check("guardedLink is null while off", links.guardedLink(good[0], H) === null);
check("restore with no saved choice stays off", links.restoreLinksEnabled() === false);
store["tfplanview-links"] = "true";
check("restore ignores anything but \"1\"", links.restoreLinksEnabled() === false);
links.setLinksEnabled(true);
check("enabling persists", store["tfplanview-links"] === "1" && links.linksEnabled());
check("guardedLink passes a good url when on", links.guardedLink(good[0], H) !== null);
check("guardedLink blocks a bad url when on", links.guardedLink("https://evil.com/", H) === null);
links.setLinksEnabled(false);
check("disabling persists", store["tfplanview-links"] === "0" && !links.linksEnabled());

/* ---- 3. hostile plan input ------------------------------------------- */
const regions = ["evil.com/#", "eu-west-1.evil.com/x", "eu-west-1@evil.com", "eu-west-1\\evil", "", "//evil", "EU-WEST-1", "eu-west-1 "];
const ids = ["i-1/../../x", "i-1#frag", "i-1\"><script>", "i-1@evil.com", "//evil.com", "https://evil.com", "i-1\n", "аws"];
const types = ["aws_instance", "aws_security_group", "aws_vpc", "aws_subnet", "aws_route_table",
               "aws_internet_gateway", "aws_nat_gateway", "aws_eip", "aws_iam_role",
               "aws_eks_cluster", "aws_eks_node_group"];
links.setLinksEnabled(true);
let escaped = 0, produced = 0;
for (const region of regions.concat(["eu-west-1", "cn-north-1", "us-gov-west-1"])) {
  for (const id of ids) {
    for (const type of types) {
      const r = { type, attrs: { id, name: id, cluster_name: id, node_group_name: id }, before: null };
      const raw = awsConsoleUrl(r, { region });
      if (raw === null) continue;
      const safe = links.guardedLink(raw, H);
      if (safe === null) { escaped++; continue; }
      produced++;
      const u = new URL(safe);
      if (!/^([a-z]{2}(-[a-z]+)+-\d+\.)?console\.(aws\.amazon\.com|amazonaws\.cn|amazonaws-us-gov\.com)$/.test(u.hostname)) escaped++;
    }
  }
}
check("hostile plan never reaches a non-console host (" + produced + " urls checked)", escaped === 0);
const eks = {
  cluster: { type: "aws_eks_cluster", attrs: { name: "prod-eks" } },
  group: { type: "aws_eks_node_group", attrs: { cluster_name: "prod-eks", node_group_name: "app-workers-v1" } }
};
check("an EKS cluster links by name, with no id",
  awsConsoleUrl(eks.cluster, { region: "us-east-1" }) === "https://us-east-1.console.aws.amazon.com/eks/clusters/prod-eks?region=us-east-1");
check("an EKS node group links under its cluster",
  awsConsoleUrl(eks.group, { region: "us-east-1" }) === "https://us-east-1.console.aws.amazon.com/eks/clusters/prod-eks/nodegroups/app-workers-v1?region=us-east-1");
check("an EKS node group without a cluster name gets no link",
  awsConsoleUrl({ type: "aws_eks_node_group", attrs: { node_group_name: "x" } }, { region: "us-east-1" }) === null);
check("an invalid region yields no link", awsConsoleUrl({ type: "aws_vpc", attrs: { id: "vpc-1" } }, { region: "evil.com/#" }) === null);
check("a hostile id stays inside the fragment",
  new URL(awsConsoleUrl({ type: "aws_vpc", attrs: { id: "x/../..?a=b#c" } }, { region: "eu-west-1" })).pathname === "/vpcconsole/home");
links.setLinksEnabled(false);

/* ---- 4. no way around the guard -------------------------------------- */
const ALLOWED = new Set(["core/links.ts", "core/registry.ts", "providers/aws/console.ts",
                         "ui/contextmenu.ts", "ui/detail.ts"]);
const risky = [/window\.open\s*\(/, /\blocation\s*(\.href)?\s*=[^=]/, /\.href\s*=[^=]/,
               /\bhref="\$\{/, /document\.write/, /\.submit\s*\(/, /\bnew\s+(WebSocket|EventSource)\b/,
               /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const offenders = [];
for (const f of walk(SRC).filter(f => f.endsWith(".ts"))) {
  const rel = path.relative(SRC, f).split(path.sep).join("/");
  const text = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const re of risky) {
    if (re.test(text) && !ALLOWED.has(rel)) offenders.push(rel + " matches " + re);
  }
}
check("no outbound navigation or network code outside the allowed files" +
  (offenders.length ? ": " + offenders.join("; ") : ""), offenders.length === 0);

/* anchors written by hand in the page are static, with fixed https targets */
const page = fs.readFileSync(path.join(SRC, "..", "index.html"), "utf8");
const hrefs = [...page.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map(m => m[1]);
check("every anchor in index.html is a fixed https url or a fragment",
  hrefs.every(h => /^https:\/\/github\.com\/dmkskd\/tf-plan-view$/.test(h) || h.startsWith("#")));

console.log(fail ? "\n" + fail + " failed" : "\nall passed");
process.exit(fail ? 1 : 0);
