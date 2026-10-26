import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// The agent's own test run (not the web app's vitest.config.ts two folders up).
export default defineConfig({
  root: here,
  resolve: {
    // as tsconfig.json's paths do for tsx: labels.ts gets bwip-js from this folder
    alias: { "bwip-js/generic": path.join(here, "node_modules/bwip-js/dist/bwip-js-gen.mjs") },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
