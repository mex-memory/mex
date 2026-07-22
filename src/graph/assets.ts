// ============================================================================
// mex code-graph — runtime asset resolution  (A5 packaging)
// ============================================================================
//
// The graph ships two kinds of non-JS asset that must resolve from the INSTALL
// location, never a repo-relative path: the SQLite `schema.sql`, and the
// tree-sitter grammar `.wasm` files. This is the #1 way a tree-sitter CLI ships
// broken — it works in-repo, then fails on `npm install` because the assets
// weren't next to the code at runtime.
//
// This module lives at `src/graph/assets.ts` on purpose. It resolves everything
// relative to `import.meta.url`, which points at:
//   * source / tests / dev : `.../src/graph/assets.ts`  → assets under `src/graph/`
//   * bundled (published)  : `.../dist/cli.js` | `.../dist/index.js`
//     (tsup inlines this module into the entry bundle) → assets under `dist/`
// The build step (`scripts/copy-graph-assets.mjs`) copies `schema.sql` and
// `wasm/` next to the bundle in `dist/`, so the SAME `<dir>/schema.sql` /
// `<dir>/wasm/<file>` lookup resolves in both layouts. A couple of extra
// candidates are probed as belt-and-suspenders across bundler layouts.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory holding this module at runtime (`src/graph/` or `dist/`). */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Return the first candidate path that exists on disk, or throw a diagnostic
 * naming every path tried (so a packaging regression is triageable, not silent).
 */
function firstExisting(candidates: string[], what: string): string {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `mex code-graph: could not locate ${what}. Looked in:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\nThis usually means the published package is missing its bundled ` +
      `assets (schema.sql / grammar .wasm). Reinstall mex-agent, or rebuild ` +
      `with \`npm run build\` when running from source.`,
  );
}

/** Absolute path to the frozen SQLite schema (`src/graph/schema.sql`). */
export function schemaPath(): string {
  return firstExisting(
    [
      join(HERE, "schema.sql"), // dist/schema.sql | src/graph/schema.sql
      join(HERE, "graph", "schema.sql"), // defensive: dist/graph/schema.sql
    ],
    "schema.sql",
  );
}

/** Absolute path to a vendored grammar `.wasm` file by basename. */
export function grammarWasmPath(wasmFile: string): string {
  return firstExisting(
    [
      join(HERE, "wasm", wasmFile), // dist/wasm/*.wasm | src/graph/wasm/*.wasm
      join(HERE, "graph", "wasm", wasmFile), // defensive: dist/graph/wasm/*.wasm
    ],
    `grammar '${wasmFile}'`,
  );
}
