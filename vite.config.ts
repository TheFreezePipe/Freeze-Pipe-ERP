import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";

/**
 * Stamps public/sw.js with a hash of the emitted bundle so every deploy
 * ships a byte-different service worker (which is what makes the browser
 * install the new one and the app show its "New version available" toast).
 */
function serviceWorkerVersion(): Plugin {
  let outDir = "dist";
  let names: string[] = [];
  return {
    name: "fp-sw-version",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    buildStart() {
      names = [];
    },
    generateBundle(_options, bundle) {
      names.push(...Object.keys(bundle));
    },
    closeBundle() {
      const file = path.join(outDir, "sw.js");
      if (!fs.existsSync(file)) return;
      const version = createHash("sha256").update(names.sort().join("\n")).digest("hex").slice(0, 12);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("__SW_VERSION__", version));
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorkerVersion()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
