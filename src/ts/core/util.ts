// core/util.ts — Pure string, DOM, HTML templating and general utilities

export function escapeHtml(s: any): string {
  return String(s).replace(/[&<>"']/g, function(c: string) {
    const map: Record<string, string> = {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
    return map[c] ?? c;
  });
}

/* Renders a diagnostic message: escapes the whole text, then turns **word**
   into <b>word</b>. Markup in a message, including in plan values, is
   therefore displayed as text. */
export function emphasisHtml(text: any): string {
  return escapeHtml(text == null ? "" : text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

export const $ = function<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
};

/**
 * Wrapper for pre-sanitized or known-safe HTML strings.
 */
export class HtmlSafeString {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type SafeHtml = HtmlSafeString;

/**
 * Mark a string as safe raw HTML (bypassing HTML escaping).
 */
export function raw(s: any): HtmlSafeString {
  return new HtmlSafeString(s === null || s === undefined ? "" : String(s));
}

/**
 * Tagged template literal for generating safe, readable HTML.
 * - Automatically escapes string/number interpolations.
 * - Leaves nested html`...` and raw(...) safe strings unescaped.
 * - Flattens arrays without commas.
 * - Omits false, null, and undefined values cleanly.
 */
export function html(strings: TemplateStringsArray, ...values: any[]): HtmlSafeString {
  var out = "";
  for (var i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      appendHtmlValue(values[i]);
    }
  }

  function appendHtmlValue(val: any): void {
    if (val === null || val === undefined || val === false) {
      return;
    }
    if (Array.isArray(val)) {
      for (var j = 0; j < val.length; j++) {
        appendHtmlValue(val[j]);
      }
    } else if (val instanceof HtmlSafeString) {
      out += val.value;
    } else {
      out += escapeHtml(val);
    }
  }

  return new HtmlSafeString(out);
}

/**
 * Copy text to clipboard with graceful fallback and button UI feedback.
 */
export function copyText(text: string, btn: HTMLElement): void {
  var orig = btn.textContent;
  function done(): void {
    btn.textContent = "copied";
    btn.classList.add("done");
    setTimeout(function() {
      btn.textContent = orig;
      btn.classList.remove("done");
    }, 1400);
  }
  function fallback(): void {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {}
    ta.remove();
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  } catch (e) {
    fallback();
  }
}
