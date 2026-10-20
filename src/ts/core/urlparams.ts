// The page address can ask for a view: ?sample=webapp&view=3d&changes=1&select=aws_lb.main
// Only the values listed here are accepted; anything else is ignored, so a link can choose between the
// things the page already offers and nothing more. A link cannot carry a plan.

export type ViewParam = "flat" | "3d" | "text";

export interface ViewParams {
  sampleId?: string;      // the id of a bundled sample
  view?: ViewParam;
  changes?: boolean;
  select?: string;        // a resource address; the caller checks it against the loaded plan
  exportSvg?: boolean;    // replace the page with the flat diagram as SVG text (for headless capture)
  tour?: boolean;         // the SVG's guided tour (on unless tour=0)
  animate?: boolean;      // any motion in the SVG: tour and pulse (on unless animate=0)
  tourStops?: number;     // how many changes the SVG's tour visits, 0 to 20
  tourDelay?: number;     // seconds before the SVG's tour starts, 0 to 60
  style?: "tour" | "replay";  // how the SVG animates
  details?: number;       // with export=svg: also a section per change, for this many changes (0 to 20)
  preview?: boolean;      // with export=svg: show the result as a comment would, with controls, instead of its source
}

/* Short names for the bundled samples. The full ids are accepted too. */
var SAMPLE_ALIASES: Record<string, string> = {
  single: "embedded-plan",
  webapp: "embedded-plan-fullstack",
  eks: "embedded-plan-eks",
  clickhouse: "embedded-plan-clickhouse"
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

  if ((q.get("export") || "").trim().toLowerCase() === "svg") out.exportSvg = true;
  var tour = (q.get("tour") || "").trim().toLowerCase();
  if (tour === "1" || tour === "true" || tour === "on") out.tour = true;
  else if (tour === "0" || tour === "false" || tour === "off") out.tour = false;
  var stops = (q.get("tourstops") || "").trim();
  if (/^\d{1,2}$/.test(stops) && +stops <= 20) out.tourStops = +stops;
  var delay = (q.get("tourdelay") || "").trim();
  if (/^\d{1,2}(\.\d{1,2})?$/.test(delay) && +delay <= 60) out.tourDelay = +delay;

  var details = (q.get("details") || "").trim();
  if (/^\d{1,2}$/.test(details) && +details <= 20) out.details = +details;

  var preview = (q.get("preview") || "").trim().toLowerCase();
  if (preview === "1" || preview === "true" || preview === "on") out.preview = true;

  var style = (q.get("style") || "").trim().toLowerCase();
  if (style === "tour" || style === "replay") out.style = style;

  var animate = (q.get("animate") || "").trim().toLowerCase();
  if (animate === "1" || animate === "true" || animate === "on") out.animate = true;
  else if (animate === "0" || animate === "false" || animate === "off") out.animate = false;

  return out;
}
