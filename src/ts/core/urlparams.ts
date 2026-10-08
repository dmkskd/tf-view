// The page address can ask for a view: ?sample=webapp&view=3d&changes=1&select=aws_lb.main
// Only the values listed here are accepted; anything else is ignored, so a link can choose between the
// things the page already offers and nothing more. A link cannot carry a plan.

export type ViewParam = "flat" | "3d" | "text";

export interface ViewParams {
  sampleId?: string;      // the id of a bundled sample
  view?: ViewParam;
  changes?: boolean;
  select?: string;        // a resource address; the caller checks it against the loaded plan
}

/* Short names for the bundled samples. The full ids are accepted too. */
var SAMPLE_ALIASES: Record<string, string> = {
  single: "embedded-plan",
  webapp: "embedded-plan-fullstack",
  eks: "embedded-plan-eks"
};
var SAMPLE_IDS = Object.keys(SAMPLE_ALIASES).map(function(k: string){ return SAMPLE_ALIASES[k]; });

var VIEWS: Record<string, ViewParam> = { flat: "flat", "3d": "3d", text: "text" };

/* Longest resource address accepted (module paths and index keys make them long, but not this long). */
var MAX_ADDRESS = 300;

export function parseViewParams(search: string): ViewParams {
  var out: ViewParams = {};
  var q: URLSearchParams;
  try { q = new URLSearchParams(search); } catch (e) { return out; }

  var sample = (q.get("sample") || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SAMPLE_ALIASES, sample)) out.sampleId = SAMPLE_ALIASES[sample];
  else if (SAMPLE_IDS.indexOf(sample) >= 0) out.sampleId = sample;

  var view = (q.get("view") || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(VIEWS, view)) out.view = VIEWS[view];

  var changes = (q.get("changes") || "").trim().toLowerCase();
  if (changes === "1" || changes === "true" || changes === "on") out.changes = true;
  else if (changes === "0" || changes === "false" || changes === "off") out.changes = false;

  var select = q.get("select") || "";
  if (select && select.length <= MAX_ADDRESS) out.select = select;

  return out;
}
