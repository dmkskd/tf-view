// core/icons.ts — adds providers' own icons to the page's SVG sprite
//
// For each icon in a provider's `icons`, addProviderIconSymbols creates a <symbol>
// with DOM calls (createElementNS, setAttribute). The only provider-supplied
// values it sets are the path data strings, which registerProviders has
// already validated (core/registry.ts, validateIcons). Each symbol matches the
// built-in icons: a rounded square filled with currentColor (the category
// colour) and the glyph paths in white.
import { getAllProviders, iconSymbolId } from "./registry.js";
import { ProviderPlugin, IconDefinition } from "../types/index.js";

var SVG = "http://www.w3.org/2000/svg";

export function addProviderIconSymbols(doc: Document): number {
  if (!doc || typeof doc.createElementNS !== "function" || typeof doc.querySelector !== "function") return 0;
  var shared = doc.querySelector("symbol[id^='i-']");
  var holder = shared && shared.parentNode;
  if (!holder) return 0;
  var n = 0;
  getAllProviders().forEach(function(p: ProviderPlugin){
    var icons = p.icons || {};
    Object.keys(icons).forEach(function(key: string){
      var id = iconSymbolId(p, key);
      if (doc.getElementById(id)) return;
      holder!.appendChild(createIconSymbol(doc, id, icons[key]));
      n++;
    });
  });
  return n;
}

function createIconSymbol(doc: Document, id: string, def: IconDefinition): Element {
  var sym = doc.createElementNS(SVG, "symbol");
  sym.setAttribute("id", id);
  sym.setAttribute("viewBox", "0 0 48 48");
  var tile = doc.createElementNS(SVG, "rect");
  tile.setAttribute("width", "48"); tile.setAttribute("height", "48");
  tile.setAttribute("rx", "9"); tile.setAttribute("fill", "currentColor");
  sym.appendChild(tile);
  var g = doc.createElementNS(SVG, "g");
  if (def.grid === 64) g.setAttribute("transform", "scale(0.75)");
  def.paths.forEach(function(d: string){
    var path = doc.createElementNS(SVG, "path");
    path.setAttribute("fill", "#fff");
    path.setAttribute("d", d);
    g.appendChild(path);
  });
  sym.appendChild(g);
  return sym;
}
