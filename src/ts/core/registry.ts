// core/registry.ts — the registered providers, and the functions that call them
//
// providers/index.ts calls registerProviders at startup; no module in core/
// imports a provider. registerProviders validates each plugin and throws on
// the first problem. The functions below find a resource's provider and call
// its hooks. For a resource with no provider they return the neutral result
// (no commands, no link, no rules, no container), not another provider's.
import {
  ProviderPlugin, ProviderSettings, CatalogEntry, CliCommand, PlanResource, PlanModel
} from "../types/index.js";
import { linksEnabled, guardedLink } from "./links.js";
import { renderCommands } from "./shell.js";
import { frozenProviderResource } from "./readonly.js";
import { callHook, checkCommands, checkUrl, checkText, checkHeight } from "./hooks.js";

var providers: ProviderPlugin[] = [];

/* Provider-block argument names that suggest a credential. A name-based
   heuristic: settingKeys matching it are refused at registration. */
var CREDENTIAL_NAME = /(key|secret|token|password|passwd|credential|cert|auth|session|assume_role|role_arn|profile|private|sas|signature|jwt|oidc)/;

export function registerProviders(list: ProviderPlugin[]): void {
  var ids: Record<string, boolean> = {}, claimed: Record<string, string> = {};
  function claim(what: string, p: ProviderPlugin): void {
    if (claimed[what]) throw new Error(what + " claimed by both " + claimed[what] + " and " + p.id);
    claimed[what] = p.id;
  }
  list.forEach(function(p: ProviderPlugin){
    if (!p || !p.id || ids[p.id]) throw new Error("provider id missing or registered twice: " + (p && p.id));
    ids[p.id] = true;
    (p.sourceAddresses || []).forEach(function(s: string){
      if (normaliseSource(s).split("/").length !== 3) throw new Error("provider " + p.id + ": source must be host/namespace/type: " + s);
      claim("source " + normaliseSource(s), p);
    });
    (p.localNames || []).forEach(function(n: string){ claim("name " + n.toLowerCase(), p); });
    /* settingKeys are for settings a diagram needs (region, project, zone).
       A key matching CREDENTIAL_NAME is refused. */
    (p.settingKeys || []).forEach(function(k: any){
      if (typeof k !== "string" || !/^[a-z][a-z0-9_]*$/.test(k) || CREDENTIAL_NAME.test(k))
        throw new Error("provider " + p.id + ": context key " + JSON.stringify(k) + " is refused: its name suggests a credential");
    });
    validateIcons(p);
    /* Colours are inserted into a style attribute, so only var(--name) or a
       hex colour is accepted. */
    Object.keys(p.categories || {}).forEach(function(c: string){
      if (!/^(var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8})$/.test(String(p.categories[c])))
        throw new Error("provider " + p.id + ": category " + c + " colour must be var(--name) or #hex");
    });
    (p.consoleHosts || []).forEach(function(h: any){
      /* a lower-case hostname with at least two labels, matched literally */
      if (!h || typeof h.host !== "string" || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h.host) ||
          (h.allowRegionPrefix !== undefined && typeof h.allowRegionPrefix !== "boolean"))
        throw new Error("provider " + p.id + ": console hosts must be {host: \"console.example.com\", allowRegionPrefix?: boolean}");
    });
  });
  providers = list.slice();
}

/* Validates icon keys, grids and path data at registration; core/icons.ts
   builds symbols from the validated definitions. Path data may contain only
   path command letters, digits, signs, decimal points, exponents, commas and
   whitespace, which excludes markup, URLs and CSS. */
var ICON_KEY = /^[a-z][a-z0-9-]{0,31}$/;
var PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/;
function validateIcons(p: ProviderPlugin): void {
  var fail = function(msg: string){ throw new Error("provider " + p.id + ": " + msg); };
  var icons: any = p.icons || {};
  var keys = Object.keys(icons);
  if (keys.length > 200) fail("more than 200 icons (the maximum)");
  keys.forEach(function(k: string){
    var d = icons[k];
    if (!ICON_KEY.test(k) || k.indexOf("i-") === 0) fail("icon key " + JSON.stringify(k) + " must be lower-case words, not starting with i-");
    if (!d || (d.grid !== undefined && d.grid !== 48 && d.grid !== 64)) fail("icon " + k + ": grid must be 48 or 64");
    if (!Array.isArray(d.paths) || !d.paths.length || d.paths.length > 16) fail("icon " + k + ": must have 1 to 16 paths");
    d.paths.forEach(function(path: any){
      if (typeof path !== "string" || path.length > 8000 || !PATH_DATA.test(path)) fail("icon " + k + ": a path contains characters other than SVG path data");
    });
  });
  Object.keys(p.catalog || {}).forEach(function(t: string){
    var icon = p.catalog[t].icon;
    var own = Object.prototype.hasOwnProperty.call(icons, icon);
    if (!own && !/^i-[a-z0-9-]+$/.test(String(icon))) fail(t + ": icon " + JSON.stringify(icon) + " is neither one of the provider's icons nor a shared i-* symbol");
  });
}

/* The id of the <symbol> core/icons.ts creates for a provider's icon. */
export function iconSymbolId(p: ProviderPlugin, key: string): string {
  return "p-" + p.id + "-" + key;
}

export function getAllProviders(): ProviderPlugin[] {
  return providers.slice();
}

/* Lower-cases a source address and adds the default registry host to a
   two-part address: "hashicorp/aws" -> "registry.terraform.io/hashicorp/aws". */
function normaliseSource(s: string): string {
  var t = String(s || "").trim().toLowerCase();
  return t.split("/").length === 2 ? "registry.terraform.io/" + t : t;
}

/* The plugin for a provider name. A name containing "/" is a source address
   and must equal one of a plugin's `sourceAddresses` after normalisation; a name
   without "/" is matched against `localNames`. An address no plugin lists
   matches no plugin, even if its last part is a known name:
   "registry.terraform.io/someone/aws" does not match the AWS plugin. */
export function getProviderForProviderName(providerName: string | null | undefined): ProviderPlugin | null {
  var n = String(providerName || "").trim();
  if (!n) return null;
  var i: number;
  if (n.indexOf("/") >= 0){
    var src = normaliseSource(n);
    for (i = 0; i < providers.length; i++){
      if ((providers[i].sourceAddresses || []).some(function(s: string){ return normaliseSource(s) === src; })) return providers[i];
    }
    return null;
  }
  for (i = 0; i < providers.length; i++){
    if ((providers[i].localNames || []).some(function(l: string){ return l.toLowerCase() === n.toLowerCase(); })) return providers[i];
  }
  return null;
}

/* The plugin whose `prefix` starts the resource type. Used only when the
   input gives no provider name (a state file, a hand-written plan). */
export function getProviderByTypePrefix(type: string): ProviderPlugin | null {
  if (!type) return null;
  for (var i = 0; i < providers.length; i++){
    var p = providers[i];
    if (p.typePrefix && type.indexOf(p.typePrefix) === 0) return p;
  }
  return null;
}

export function getProviderById(id: string | null | undefined): ProviderPlugin | null {
  if (!id) return null;
  for (var i = 0; i < providers.length; i++){
    if (providers[i].id === id) return providers[i];
  }
  return null;
}

/* The plugin for a resource: r.provider (set by the parser) if present;
   otherwise r.provider_name; the type prefix only if the resource has
   neither. A resource whose provider_name matches no plugin has no provider,
   so no provider's hooks are called for it. */
export function getProviderForResource(res: PlanResource | null | undefined): ProviderPlugin | null {
  if (!res) return null;
  if (res.provider) return getProviderById(res.provider);
  if (res.provider_name) return getProviderForProviderName(res.provider_name);
  return getProviderByTypePrefix(res.type);
}

export function isProviderSupported(providerName: string): boolean {
  return !!getProviderForProviderName(providerName);
}

export function supportedProviderNames(): string[] {
  return providers.reduce(function(a: string[], p: ProviderPlugin){ return a.concat(p.localNames || []); }, []);
}

/* A type's catalog entry, from the given provider or, if none is given, the
   provider whose prefix matches. The returned entry is a frozen copy in which
   a key of the provider's `icons` is replaced by its symbol id
   (iconSymbolId), so the UI receives only symbol ids. Cached per provider
   and type. */
var catalogCache: WeakMap<ProviderPlugin, Record<string, CatalogEntry>> = new WeakMap();
export function catalogEntry(type: string, p?: ProviderPlugin | null): CatalogEntry | null {
  var owner = p || getProviderByTypePrefix(type);
  if (!owner || !owner.catalog || !Object.prototype.hasOwnProperty.call(owner.catalog, type)) return null;
  var cache = catalogCache.get(owner);
  if (!cache){ cache = Object.create(null) as Record<string, CatalogEntry>; catalogCache.set(owner, cache); }
  if (!cache[type]){
    var e = owner.catalog[type];
    var own = !!owner.icons && Object.prototype.hasOwnProperty.call(owner.icons, e.icon);
    cache[type] = Object.freeze(own ? Object.assign({}, e, {icon: iconSymbolId(owner, e.icon)}) : Object.assign({}, e));
  }
  return cache[type];
}

/* The type without its provider's prefix, for labels: "aws_iam_role" -> "iam_role". */
export function typeWithoutPrefix(type: string, p?: ProviderPlugin | null): string {
  var owner = p || getProviderByTypePrefix(type);
  return (owner && owner.typePrefix && type.indexOf(owner.typePrefix) === 0) ? type.slice(owner.typePrefix.length) : type;
}

/* Category colours and labels, merged across providers in registration order;
   the first provider to name a category decides its colour and label. */
export function categoryColor(cat: string | null | undefined): string | null {
  if (!cat) return null;
  for (var i = 0; i < providers.length; i++){
    var c = providers[i].categories;
    if (c && Object.prototype.hasOwnProperty.call(c, cat)) return c[cat];
  }
  return null;
}

export function categoryLabels(): [string, string][] {
  var seen: Record<string, boolean> = {}, out: [string, string][] = [];
  providers.forEach(function(p: ProviderPlugin){
    (p.categoryLabels || []).forEach(function(c: [string, string]){
      if (c[0] === "other" || seen[c[0]]) return;
      seen[c[0]] = true;
      out.push(c);
    });
  });
  out.push(["other", "Not implemented"]);
  return out;
}

/* The provider-block settings passed to a provider's hooks. For a resource,
   the settings of the block it uses (r.providerBlock, aliases such as
   google.prod included), if that block belongs to provider p; otherwise
   p's default block. Settings of another provider's blocks are never
   returned. The result is a new object; callers freeze it before passing
   it to a hook. */
export function settingsFor(model: PlanModel | null | undefined, p: ProviderPlugin | null, r?: PlanResource | null): ProviderSettings {
  if (!model || !p) return {};
  var key = r && r.providerBlock;
  var own = key && model.providerBlocks && model.providerBlocks[key];
  var c = (own && own.provider === p.id) ? own.settings : ((model.defaultProviderSettings || {})[p.id] || {});
  var out: ProviderSettings = {};
  Object.keys(c).forEach(function(k: string){ out[k] = c[k]; });
  return out;
}

/* The names the UI shows for this resource's provider tools ("AWS CLI",
   "AWS console"), with generic defaults. */
export function toolNames(r: PlanResource): { cli: string; console: string } {
  var p = getProviderForResource(r);
  return { cli: (p && p.cliName) || "CLI", console: (p && p.consoleName) || "console" };
}

/* The hooks below are called through callHook (core/hooks.ts), with a frozen
   copy of the resource (core/readonly.ts) and, for cli and consoleUrl, a
   frozen copy of its provider-block settings. */

export function cliCommands(r: PlanResource, model?: PlanModel | null): CliCommand[] {
  var p = getProviderForResource(r);
  if (!p || !p.cli) return [];
  var settings = Object.freeze(settingsFor(model, p, r));
  var pl = p;
  return renderCommands(callHook(p, "cli", model, function(){ return pl.cli(frozenProviderResource(r), settings); }, checkCommands, []));
}

export function consoleLink(r: PlanResource, model?: PlanModel | null): string | null {
  var p = getProviderForResource(r);
  if (!linksEnabled() || !p || !p.consoleUrl) return null;
  var settings = Object.freeze(settingsFor(model, p, r));
  var pl = p;
  var url = callHook(p, "consoleUrl", model, function(){ return pl.consoleUrl!(frozenProviderResource(r), settings); }, checkUrl, null);
  return guardedLink(url, p.consoleHosts || []);
}

/* The text of a tile's second line: the value of the catalog's `sub`
   attribute, passed through the provider's tileSubtitle if it has one. */
export function tileSubtitleFor(r: PlanResource, value: string): string {
  var p = getProviderForResource(r);
  if (!p || !p.tileSubtitle) return value;
  var pl = p;
  return callHook(p, "tileSubtitle", null, function(){ return pl.tileSubtitle!(frozenProviderResource(r), value); }, checkText(200), value);
}

export function blockHeight(r: PlanResource): number {
  var p = getProviderForResource(r);
  if (!p || !p.sizing || !p.sizing.blockHeight) return 26;
  var pl = p;
  return callHook(p, "blockHeight", null, function(){ return pl.sizing!.blockHeight(frozenProviderResource(r)); }, checkHeight, 26);
}
