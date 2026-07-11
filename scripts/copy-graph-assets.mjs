// Copy the code-graph runtime assets next to the bundled output in dist/, so
// they resolve from the INSTALL location at runtime (see src/graph/assets.ts).
// tsup bundles JS only; these non-JS assets must be copied explicitly, and they
// ship via package.json's `files: ["dist", ...]`. Runs after `tsup` in the
// build script — the #1 way a tree-sitter CLI ships broken is by omitting this.

import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const graphSrc = join(root, "src", "graph");
const dist = join(root, "dist");

mkdirSync(dist, { recursive: true });

// 1) The frozen SQLite schema → dist/schema.sql
cpSync(join(graphSrc, "schema.sql"), join(dist, "schema.sql"));

// 2) The vendored tree-sitter grammar WASMs → dist/wasm/*.wasm
const wasmSrc = join(graphSrc, "wasm");
const wasmDist = join(dist, "wasm");
mkdirSync(wasmDist, { recursive: true });
const wasmFiles = readdirSync(wasmSrc).filter((f) => f.endsWith(".wasm"));
for (const file of wasmFiles) {
  cpSync(join(wasmSrc, file), join(wasmDist, file));
}

console.log(
  `[copy-graph-assets] copied schema.sql + ${wasmFiles.length} grammar wasm file(s) to dist/`,
);
