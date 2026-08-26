// Copy the built web UI next to the bundled output in dist/, so it resolves
// from the INSTALL location at runtime (see src/ui/assets.ts). Mirrors
// copy-graph-assets.mjs: tsup bundles JS only, and these static files ship via
// package.json's `files: ["dist", ...]`.
//
// Missing frontend output is a warning, not an error: `npm run build:cli` alone
// is a valid inner-loop build, and the server degrades to an actionable page
// telling you to build the UI.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uiSrc = join(root, "packages", "mex-ui", "dist");
const uiDist = join(root, "dist", "ui");

if (!existsSync(join(uiSrc, "index.html"))) {
  console.warn(
    "[copy-ui-assets] packages/mex-ui/dist/index.html not found — skipping. " +
      "Run `npm run build:ui` to bundle the web dashboard.",
  );
  process.exit(0);
}

rmSync(uiDist, { recursive: true, force: true });
mkdirSync(dirname(uiDist), { recursive: true });
cpSync(uiSrc, uiDist, { recursive: true });

console.log("[copy-ui-assets] copied packages/mex-ui/dist to dist/ui/");
