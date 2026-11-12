// Exercise every picker entry with both the development and standalone sample data.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");

(async () => {
  const built = fs.readFileSync(path.join(root, "dist/index.html"), "utf8");
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.join(root, "vite.config.mjs"),
    server: { host: "127.0.0.1", port: 0, open: false, hmr: false, ws: false }
  });
  let source;
  try {
    await server.listen();
    const response = await fetch(`http://127.0.0.1:${server.httpServer.address().port}/`);
    assert.equal(response.status, 200);
    source = await response.text();
  } finally {
    await server.close();
  }
  // jsdom cannot run Vite's module entry; use the same app compiled by the standalone build.
  const app = [...built.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]).sort((a, b) => b.length - a.length)[0];
  const development = source.replace(/<script type="module" src="(?:\.\/|\/)ts\/main.ts"><\/script>/,
    () => `<script>${app}</script>`);

  for (const [mode, html] of [["development", development], ["standalone", built]]) {
    const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
    try {
      const errors = [];
      dom.window.addEventListener("error", e => errors.push(e.message));
      await new Promise(resolve => dom.window.addEventListener("load", resolve, { once: true }));
      const doc = dom.window.document;
      const expected = [/bundled sample/, /full-stack/, /eks/, /clickhouse/];
      for (let i = 0; i < expected.length; i++) {
        doc.getElementById("sampleBtn").click();
        const menu = doc.getElementById("sampleMenu");
        const buttons = menu.querySelectorAll("button");
        assert.equal(buttons.length, 4);
        const label = buttons[i].textContent;
        buttons[i].click();
        assert.equal(menu.hidden, true);
        assert.match(doc.getElementById("srcName").textContent, expected[i]);
        assert.ok(doc.querySelectorAll(".node").length > 0, `${label} renders resources`);
        assert.deepEqual(errors, []);
        console.log(`  ok   ${mode}: ${label}`);
      }
    } finally {
      dom.window.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
