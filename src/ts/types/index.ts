// types/index.ts — Core TypeScript definitions for tfplanview

export type ActionType = "create" | "update" | "delete" | "replace" | "no-op" | "read";

export interface PlanAttributeChange {
  actions: string[];
  before: Record<string, any> | null;
  after: Record<string, any> | null;
  after_unknown?: Record<string, any>;
  before_sensitive?: Record<string, any> | boolean;
  after_sensitive?: Record<string, any> | boolean;
}

// Raw untrusted Terraform CLI JSON format (terraform show -json)
export interface TerraformResourceChange {
  address: string;
  previous_address?: string;
  module_address?: string;
  mode: "managed" | "data" | string;
  type: string;
  name: string;
  provider_name?: string;
  change: {
    actions: string[];
    before?: Record<string, any> | null;
    after?: Record<string, any> | null;
    after_unknown?: Record<string, any>;
    before_sensitive?: Record<string, any> | boolean;
    after_sensitive?: Record<string, any> | boolean;
    replace_paths?: (string | (string | number)[])[];
    [key: string]: any;
  };
  action_reason?: string;
  [key: string]: any;
}

export interface TerraformConfigurationResource {
  address: string;
  mode?: string;
  type: string;
  name: string;
  provider_config_key?: string;
  expressions?: Record<string, any>;
  schema_version?: number;
  depends_on?: string[];
  [key: string]: any;
}

export interface TerraformConfigurationModule {
  resources?: TerraformConfigurationResource[];
  module_calls?: Record<string, {
    source?: string;
    module?: TerraformConfigurationModule;
    [key: string]: any;
  }>;
  [key: string]: any;
}

export interface TerraformPlannedValues {
  root_module?: {
    resources?: Array<{
      address: string;
      mode?: string;
      type: string;
      name: string;
      provider_name?: string;
      schema_version?: number;
      values?: Record<string, any>;
      sensitive_values?: Record<string, any>;
      [key: string]: any;
    }>;
    child_modules?: any[];
    [key: string]: any;
  };
  [key: string]: any;
}

export interface TerraformResourceDrift {
  address: string;
  change?: {
    actions?: string[];
    before?: Record<string, any>;
    after?: Record<string, any>;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface TerraformCheck {
  address?: {
    to_display?: string;
    kind?: string;
    [key: string]: any;
  };
  status?: string;
  instances?: Array<{
    problems?: Array<{ message: string; [key: string]: any }>;
    [key: string]: any;
  }>;
  [key: string]: any;
}

export interface TerraformPlanJson {
  format_version?: string;
  terraform_version?: string;
  timestamp?: string | null;
  applyable?: boolean;
  errored?: boolean;
  variables?: Record<string, { value?: any; [key: string]: any }>;
  resource_changes?: TerraformResourceChange[];
  configuration?: {
    root_module?: TerraformConfigurationModule;
    provider_config?: Record<string, any>;
    [key: string]: any;
  };
  values?: any;
  planned_values?: TerraformPlannedValues;
  resource_drift?: TerraformResourceDrift[];
  checks?: TerraformCheck[];
  output_changes?: Record<string, any>;
  prior_state?: any;
  relevant_attributes?: any[];
  annotations?: {
    llm_review?: LlmReview;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface LlmResourceInsight {
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | string;
  irreversible: boolean;
  badge: string;
  note: string;
}

export interface LlmReviewMetrics {
  duration_ms: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

export interface LlmReview {
  provider?: string;
  model: string;
  scope: "changes" | "full" | string;
  depth: "standard" | "expert" | string;
  metrics: LlmReviewMetrics;
  summary: string;
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | string;
  blast_radius: string;
  key_warnings: string[];
  resources: Record<string, LlmResourceInsight>;
}

export interface PlanResource {
  address?: string;
  addr: string;
  mode?: string;
  type: string;
  name: string;
  provider?: string;
  provider_name?: string;
  schema_version?: number;
  values?: Record<string, any>;
  attrs?: Record<string, any>;
  before?: Record<string, any> | null;
  change?: PlanAttributeChange;
  expressions?: Record<string, any>;
  depends_on?: string[];
  refs: string[];
  /* the part of refs that only the saved state graph supplies (the configuration
     cannot see it, typically because it goes through a local) */
  stateRefs?: string[];
  /* the module it lives in ("module.net[0]"), empty at the root */
  module?: string;
  /* the provider block it uses (a key of model.providerBlocks), when known */
  providerBlock?: string;
  action: ActionType;
  actionReason?: string | null;
  spec?: CatalogEntry | null;
  kind?: string;
  foreign?: boolean;
  supported?: boolean;
  unsupported?: boolean;
  enabledType?: boolean;
  hidden?: boolean;
  unknown?: Record<string, any>;
  /* before_sensitive and after_sensitive together; attrs and before are
     already redacted with it (core/redact.ts) */
  sensitive?: Record<string, any> | boolean;
  /* the plan marked the whole resource sensitive (mask `true`) */
  wholeResourceSensitive?: boolean;
  /* keys whose sensitive value differs between before and after; after
     redaction both sides read "(sensitive value)", so a comparison of attrs
     and before cannot detect the change */
  changedSensitiveKeys?: string[];
  replacePaths?: (string | (string | number)[])[];
  dependents?: string[];
  llmInsight?: LlmResourceInsight | null;
}

/* msg is plain text, not HTML; **word** marks emphasis (rendered by
   emphasisHtml). hint is optional hover text. */
export interface DiagnosticItem {
  level: "err" | "warn" | "ok" | "info";
  code: string;
  msg: string;
  detail?: string | string[] | null;
  hint?: string;
}

/* what changed outside Terraform since the last apply */
export interface DriftEntry {
  address: string;
  type: string;
  name: string;
  before: Record<string, any>;
  after: Record<string, any>;
}

/* one check block's result, flattened to what is shown */
export interface CheckEntry {
  name: string;
  status: string;
  problems: string[];
}

export interface OutputChange {
  actions: string[];
  after: any;
  afterUnknown: boolean;
  afterSensitive: boolean;
}

export interface PlanModel {
  source: string;
  tfVersion: string | null;
  formatVersion: string | null;
  resources: PlanResource[];
  byAddr: Record<string, PlanResource>;
  cfgByAddr: Record<string, any>;
  diagnostics: DiagnosticItem[];
  typeCounts: Record<string, number>;
  summary: {
    create: number;
    update: number;
    replace: number;
    delete: number;
    noop?: number;
    total?: number;
    [key: string]: number | undefined;
  } | null;
  /* the region shown in the plan header: that of the first registered
     provider with resources in the plan */
  region?: string | null;
  /* by provider id: the settings of the provider's default block (its root,
     unaliased block, or else the first block read) */
  defaultProviderSettings: Record<string, ProviderSettings>;
  /* every provider block of a registered provider, by its key ("aws",
     "aws.west", "module.db:aws"): the provider id and the block's settings */
  providerBlocks: Record<string, { provider: string; settings: ProviderSettings }>;
  /* by provider id: the version constraint of its default block */
  providerVersionConstraints: Record<string, string>;
  /* the input as loaded, unredacted. Used only by the raw-JSON panels in Plan
     info; the rest of the UI reads the typed fields above. */
  raw?: TerraformPlanJson | any;
  rawText?: string;
  rawBytes?: number;
  timestamp?: string | null;
  hasEdits?: boolean;
  anc?: Record<string, string[]>;
  drift?: string[];
  outputs?: Record<string, OutputChange> | null;
  driftDetails: DriftEntry[];
  checks: CheckEntry[];
  variables: Record<string, any>;
  llmReview?: LlmReview | null;
  diag?: (level: "err" | "warn" | "ok" | "info", code: string, msg: string, detail?: string | string[] | null | any, hint?: string) => void;
}

export interface LayoutLeaf {
  box?: false;
  res: PlanResource;
  w?: number;
  h?: number;
  x?: number;
  y?: number;
}

export type LayoutNode = LayoutGroup | LayoutLeaf;

export interface LayoutRow {
  items: LayoutNode[];
  w: number;
  h?: number;
}

export interface LayoutGroup {
  box: true;
  cls: string;
  label: string;
  meta: string;
  children: LayoutNode[];
  maxW?: number;
  stack?: boolean;
  breakBefore?: boolean;
  w: number;
  h: number;
  x: number;
  y: number;
  res?: PlanResource;
  _rows?: LayoutRow[];
}

/* Core's state while it lays out one provider's cloud. Not passed to
   providers, which use PlacementApi. */
export interface LayoutContext {
  opts?: RenderOptions;
  vis: PlanResource[];
  cloud: LayoutGroup;
  region: LayoutGroup;
  global: LayoutGroup;
  unplaced: LayoutGroup;
  referrers: Record<string, PlanResource[]>;
  byAddr: Record<string, PlanResource>;
  provider: ProviderPlugin | null;
  session: PlacementSession | null;
  boxesByRef: Map<string, LayoutGroup>;   /* ContainerRef -> the box created for it */
  boxedAddresses: Set<string>;            /* addresses drawn as a box (ContainerSpec.resource) */
  error?: () => string | null;            /* the first placement error after start(), if any */
}

/* One resource type, as plain data. scope "global" or "region" places the
   tile directly in that box; "network" asks the provider's placement for a
   container and uses the region box if it returns none. */
export interface CatalogEntry {
  kind?: "node" | "group" | "assoc";
  label: string;
  icon: string;
  cat?: string;
  preview?: string[];
  scope?: "global" | "region" | "network";
  sub?: string;
}

/* A provider's own icon: the glyph as SVG path data on a 48- or 64-unit
   grid. Core creates the <symbol>, the background tile (filled with the
   category colour) and the white <path> elements; the provider supplies only
   the path data strings. */
export interface IconDefinition {
  grid?: 48 | 64;          /* default 48 */
  paths: string[];         /* SVG path data, e.g. "M12 14 L36 14 ..." */
}

/* ---- what providers see ------------------------------------------------ */

/* A value as it appears in a plan, read-only at every level. */
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue; }

/* The resource as every provider hook receives it: a frozen copy with only
   these fields, already redacted (sensitive values read "(sensitive value)"). */
export interface ProviderResource {
  readonly addr: string;               /* "module.net.aws_subnet.a[0]" */
  readonly type: string;               /* "aws_subnet" */
  readonly name: string;               /* the Terraform label: "a" */
  readonly module: string;             /* "module.net", "" at the root */
  readonly action: ActionType;
  readonly attrs: JsonObject;          /* planned values; for a delete, the current values */
  readonly before: JsonObject | null;  /* current values; null for a create */
  readonly refs: ReadonlyArray<string>;/* addresses of the resources in this plan it references */
  readonly spec: Readonly<CatalogEntry> | null;
  readonly providerBlock: string | null;  /* the provider block it uses: "google.prod" */
}

/* A command line ready to show and copy. Only core/shell.ts builds these. */
export interface CliCommand {
  label: string;
  cmd: string;
}

/* A command as a provider's cli hook returns it: the program and its
   arguments, unquoted. core/shell.ts quotes each argument for POSIX sh, bash
   and zsh. */
export interface ProviderCommand {
  label: string;
  argv: string[];
}

export interface RuleSection {
  title: string;
  body: string;
}

/* One rule of a rule list (a security group or ACL entry) as plain-text
   fields. The provider's rules.describe returns it; core/rules.ts escapes
   the fields and renders them. */
export interface RuleDescription {
  ports: string;              /* "443", "all", "1024–65535" */
  service: string;            /* a well-known name for the port, or "" */
  protocol: string;           /* "tcp", "all" */
  peer: string;               /* where traffic comes from or goes to */
  number?: string | null;     /* the rule's number, where rules are numbered */
  order?: number;             /* sort key, when the list is evaluated in order */
  action?: string | null;     /* "allow" or "deny", where rules can deny */
  description?: string | null;
}

/* One direction of a rule list: the attribute that holds it, and its labels. */
export interface RuleListDirection {
  attr: string;               /* "ingress" */
  inbound: boolean;
  peerHeading: string;        /* "Source" */
}

/* Describes a resource's rule lists, for core/rules.ts to render. */
export interface RuleListSpec {
  title: string;              /* detail section title: "Security group rules" */
  name: string;               /* short name for the hover card: "security group" */
  ordered: boolean;           /* numbered, first match wins, with an action per rule */
  note: string;               /* one sentence on how the lists are evaluated */
  directions: RuleListDirection[];
  implicit?: RuleDescription;        /* the rule every list ends with, if any (an ACL's deny-all) */
}

/* Rule-list hooks. All returned values are plain text; core escapes them. */
export interface ProviderRules {
  ruleSet: (r: ProviderResource) => RuleListSpec | null;
  describe: (entry: JsonValue) => RuleDescription;
  key: (entry: JsonValue) => string;  /* entries with equal keys are treated as the same rule */
}

/* A reference to a box created by addContainer. Opaque to the provider. */
export type ContainerRef = string;

export interface ContainerSpec {
  cls: string;            /* CSS class: lower-case words, e.g. "subnet private" */
  label: string;          /* plain text */
  meta?: string;          /* plain text, shown beside the label */
  maxW?: number;          /* width at which the box wraps its children into a new row */
  stack?: boolean;        /* lay children out in one column, in order */
  breakBefore?: boolean;  /* place this box at the start of a new row */
  resource?: string;      /* address of the resource this box draws, if any */
}

/* The interface a provider's placement receives: frozen, redacted copies of
   its own resources, its provider-block settings, and addContainer. Core
   validates each addContainer call (core/placement.ts). */
export interface PlacementApi {
  readonly resources: ReadonlyArray<ProviderResource>;
  readonly defaultSettings: Readonly<ProviderSettings>;        /* the default block's settings */
  settingsOf: (addr: string) => Readonly<ProviderSettings>;   /* settings of the block this resource uses */
  readonly region: ContainerRef;
  readonly global: ContainerRef;
  addContainer: (parent: ContainerRef, spec: ContainerSpec) => ContainerRef;
}

/* Returned by start(); answers questions for the rest of one layout. */
export interface PlacementSession {
  containerOf: (addr: string) => ContainerRef | null;   /* the box for this resource's tile, or null */
}

export interface ProviderPlacement {
  start: (api: PlacementApi) => PlacementSession;
}

export interface ProviderSizing {
  blockHeight: (r: ProviderResource) => number;
}

/* Values read from a provider block in the plan ("region", "project"), as
   the hooks receive them: only the keys the provider lists in settingKeys,
   and only literal values or non-sensitive root variables. */
export type ProviderSettings = Record<string, string>;

/* A console host, as an exact hostname: "console.aws.amazon.com". With
   allowRegionPrefix, "<region>.console.aws.amazon.com" also matches, where
   <region> has the form of a region name ("eu-west-1"; the format is
   REGION_LABEL in core/links.ts). */
export interface ConsoleHost {
  host: string;
  allowRegionPrefix?: boolean;
}

export interface ProviderPlugin {
  id: string;                  /* "aws" */
  name: string;                /* "AWS" */
  /* Source addresses this plugin handles, as Terraform writes them in
     provider_name: "registry.terraform.io/hashicorp/aws". Compared
     case-insensitively; a two-part address ("hashicorp/aws") means the
     default registry, registry.terraform.io. */
  sourceAddresses: string[];
  /* Provider local names ("aws"), used only when the input gives no source
     address (a plan without full_name, a hand-written plan). */
  localNames: string[];
  /* Resource type prefix ("aws_"), used only for a resource without
     provider_name (a state file, a hand-written plan). */
  typePrefix: string;
  /* the provider's own icons; a catalog `icon` is either a key of this
     object or a shared "i-*" symbol from index.html */
  icons?: Record<string, IconDefinition>;
  catalog: Record<string, CatalogEntry>;
  categories: Record<string, string>;
  categoryLabels: [string, string][];
  cloudLabel: string;          /* label of the provider's outermost box: "AWS Cloud" */
  globalNote?: string;         /* text beside the "Global" box's label */
  unplacedNote?: string;       /* text beside the "Unplaced" box's label */
  settingKeys?: string[];      /* provider-block arguments the hooks receive: ["region"] */
  cliName?: string;            /* "AWS CLI" */
  consoleName?: string;        /* "AWS console" */
  /* the hosts consoleUrl may link to; core also rejects non-https URLs,
     credentials, ports, and URLs over 2048 characters */
  consoleHosts?: ConsoleHost[];
  cli: (r: ProviderResource, ctx: Readonly<ProviderSettings>) => ProviderCommand[];
  consoleUrl?: (r: ProviderResource, ctx: Readonly<ProviderSettings>) => string | null;
  /* formats a tile's second line (the value of catalog `sub`), e.g.
     "com.amazonaws.eu-west-1.s3" -> "s3" */
  tileSubtitle?: (r: ProviderResource, value: string) => string;
  sizing?: ProviderSizing;
  rules?: ProviderRules;
  placement: ProviderPlacement;
}

export interface RenderOptions {
  showAssoc: boolean;
  showUnsup: boolean;
  edges: string;
  mode: string;
  render: "diagram" | "text";
  action: string | null;
  pulse: boolean;
  showLlm: boolean;
}

export interface AppState {
  model: PlanModel | null;
  selected: string | null;
  opts: RenderOptions;
  nodeEls: Record<string, HTMLElement>;
  suppressClick: boolean;
}
