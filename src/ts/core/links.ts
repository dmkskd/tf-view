// core/links.ts — validates links built from plan data
//
// The page's Content-Security-Policy does not restrict where a link navigates,
// so links built from plan data are validated here instead. guardedLink
// returns null while links are turned off (the default) and, when they are on,
// returns a URL only if it is https, has no credentials or port, is at most
// 2048 characters, and its host is one the resource's provider declares in
// consoleHosts. consoleUrl (core/registry.ts) passes every console link
// through guardedLink; tools/check-links.js checks that no other source file
// opens windows, assigns locations or builds an href from a variable.

var LINKS_KEY = "tfplanview-links";
var linksOn = false;

import { ConsoleHost } from "../types/index.js";

var MAX_URL_LENGTH = 2048;
/* the form of the label a regional host may have in front: "eu-west-1",
   "us-gov-west-1" */
var REGION_LABEL = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/* True if hostname equals a declared host or, where allowRegionPrefix is
   set, is a region-shaped label followed by "." and the declared host. The
   comparison is string equality, not a pattern match. */
export function isDeclaredHost(hostname: string, hosts: ConsoleHost[]): boolean {
  return (hosts || []).some(function(h: ConsoleHost){
    if (hostname === h.host) return true;
    if (!h.allowRegionPrefix) return false;
    var suffix = "." + h.host;
    return hostname.length > suffix.length &&
           hostname.slice(-suffix.length) === suffix &&
           REGION_LABEL.test(hostname.slice(0, -suffix.length));
  });
}

export function safeExternalUrl(url: any, hosts: ConsoleHost[]): string | null {
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
  var u: URL;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password || u.port) return null;
  if (!isDeclaredHost(u.hostname, hosts)) return null;
  return u.href;
}

export function linksEnabled(): boolean { return linksOn; }

export function setLinksEnabled(on: boolean): void {
  linksOn = !!on;
  try { localStorage.setItem(LINKS_KEY, linksOn ? "1" : "0"); } catch (e) {}
}

/* Restores the user's earlier choice from localStorage. Neither the plan nor
   the page URL is read. */
export function restoreLinksEnabled(): boolean {
  try { linksOn = localStorage.getItem(LINKS_KEY) === "1"; } catch (e) { linksOn = false; }
  return linksOn;
}

/* null while links are off; otherwise the URL if safeExternalUrl accepts it. */
export function guardedLink(url: string | null, hosts: ConsoleHost[]): string | null {
  if (!linksOn || !url) return null;
  return safeExternalUrl(url, hosts);
}

/* Hover text for a link: what the click does, and the full destination URL. */
export function linkTitle(url: string, consoleName: string): string {
  return "Opens this resource in the " + consoleName + ":\n" + url;
}
