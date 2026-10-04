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
  sensitive?: Record<string, any> | boolean;
  replacePaths?: (string | (string | number)[])[];
  dependents?: string[];
  llmInsight?: LlmResourceInsight | null;
}

export interface DiagnosticItem {
  level: "err" | "warn" | "ok" | "info";
  code: string;
  msg: string;
  detail?: string | string[] | null;
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
  region?: string | null;
  /* the input as read. Only the raw-JSON inspector panels may use this; the
     rest of the UI reads the typed fields above, so it never depends on which
     kind of file was loaded. */
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
  providerConstraint?: string | null;
  llmReview?: LlmReview | null;
  diag?: (level: "err" | "warn" | "ok" | "info", code: string, msg: string, detail?: string | string[] | null | any) => void;
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

export interface LayoutContext {
  model?: PlanModel | null;
  opts?: RenderOptions;
  vis: PlanResource[];
  cloud?: LayoutGroup;
  region: LayoutGroup;
  global?: LayoutGroup;
  unplaced?: LayoutGroup;
  vpcGroups: Record<string, LayoutGroup>;
  vpcWideGroups?: Record<string, LayoutGroup>;
  subnetVpcGroups?: Record<string, LayoutGroup>;
  subnetGroups: Record<string, LayoutGroup>;
  azGroups: Record<string, LayoutGroup>;
  /* One SG address can now have several boxes — one per distinct container
     its members actually ended up in, rather than one arbitrarily-chosen
     "host" for the whole group. */
  sgGroups: Record<string, LayoutGroup[]>;
  ownerOf: Record<string, LayoutGroup>;
  referrers?: Record<string, PlanResource[]>;
  byAddr?: Record<string, PlanResource>;
  networkGroups?: Record<string, LayoutGroup>;
  subnetworkGroups?: Record<string, LayoutGroup>;
  regionGroups?: Record<string, LayoutGroup>;
}

export interface CatalogEntry {
  kind?: "node" | "group" | "assoc" | string;
  g?: string;
  label: string;
  icon: string;
  cat?: string;
  preview?: string[];
  scope?: string;
  sub?: string;
  isBoundary?: (r: PlanResource) => boolean;
}

export interface CliCommand {
  label: string;
  cmd: string;
}

export interface RuleSection {
  title: string;
  body: string;
}

export interface AwsRuleEntry {
  protocol?: string | number;
  from_port?: number;
  to_port?: number;
  cidr_blocks?: string[];
  ipv6_cidr_blocks?: string[];
  prefix_list_ids?: string[];
  security_groups?: string[];
  self?: boolean;
  cidr_block?: string;
  ipv6_cidr_block?: string;
  rule_no?: number;
  action?: string;
  description?: string;
  [key: string]: any;
}

export interface ProviderRules {
  rulesHtml?: (r: PlanResource) => RuleSection | null;
  isRuleAttr?: (kOrR: any, aOrK?: any, bOrA?: any, maybeB?: any) => boolean;
  ruleKey?: (rOrE: any, maybeE?: any) => string;
  ruleRow?: (rOrE: any, markOrE?: any, dirOrMark?: any, maybeDir?: any) => string;
  popRow?: (rOrE: any, dirOrMark?: any, isNacl?: boolean, mark?: any) => string;
  ruleLines?: (r: PlanResource, dir: string, isNacl?: boolean, opts?: any, matchRulesFn?: any, attrKindFn?: any, sameValFn?: any) => string;
  PORT_NAME?: Record<number, string>;
  portName?: (e: any) => string;
  portText?: (r: any) => string;
  protoText?: (p: any) => string;
  peerText?: (e: any) => string;
}

export interface ProviderPlacement {
  placeContainers: (ctx: LayoutContext) => void;
  containerOf: (ctx: LayoutContext, r: PlanResource) => LayoutGroup | null;
  isBoundary: (ctx: LayoutContext, r: PlanResource) => boolean;
  vpcOf?: (ctx: LayoutContext, r: PlanResource) => LayoutGroup | null;
  subnetOf?: (ctx: LayoutContext, r: PlanResource) => LayoutGroup | null;
  placeVpcs?: (ctx: LayoutContext) => void;
  placeSubnets?: (ctx: LayoutContext) => void;
  placeSecurityGroups?: (ctx: LayoutContext) => void;
  placeNetworks?: (ctx: LayoutContext) => void;
  placeSubnetworks?: (ctx: LayoutContext) => void;
}

export interface ProviderSizing {
  blockHeight: (r: PlanResource) => number;
  SIZE_H?: Record<string, number>;
}

export interface ProviderPlugin {
  id: string;
  name: string;
  prefix: string;
  catalog: Record<string, CatalogEntry>;
  categories: Record<string, string>;
  categoryLabels: [string, string][];
  cli: (r: PlanResource, ctx?: any) => CliCommand[];
  consoleUrl?: (r: PlanResource, ctx?: any) => string | null;
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
