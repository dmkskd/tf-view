import { defineConfig } from "vite";
import samples from "./scripts/sample-plans.js";

export default defineConfig({
  root: "src",
  plugins: [{
    name: "embedded-samples",
    transformIndexHtml(html) {
      return html.replace("<!-- sample-plans -->", () => samples.samplePlanTags());
    }
  }],
  server: {
    port: 3000,
    open: false
  },
  build: {
    outDir: "../dist",
    emptyOutDir: false
  }
});
