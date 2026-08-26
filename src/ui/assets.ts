// ============================================================================
// Web UI static asset resolution
// ============================================================================
//
// Mirrors the strategy in `src/graph/assets.ts`: resolve relative to
// `import.meta.url` and probe the layouts this module can end up in, so the
// same lookup works from source, from `dist/`, and from an installed package.
//
//   * bundled (published) : `.../dist/cli.js`   → assets at `dist/ui/`
//   * source / tests      : `.../src/ui/`       → assets at `packages/mex-ui/dist/`
//
// `scripts/copy-ui-assets.mjs` performs the dist/ copy after the frontend
// build, the same way graph grammars are copied.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Candidate directories that may hold the built frontend, in priority order. */
export function uiAssetCandidates(): string[] {
  return [
    join(HERE, "ui"), // dist/ui  (packaged)
    resolve(HERE, "../packages/mex-ui/dist"), // dist/../packages/... (repo, built CLI)
    resolve(HERE, "../../packages/mex-ui/dist"), // src/ui/../../packages/... (source)
  ];
}

/**
 * Absolute path to the built frontend, or null when it hasn't been built. The
 * server renders an actionable page in that case rather than failing to start,
 * so `mex ui` in a source checkout tells you what to run.
 */
export function findUiAssetDir(): string | null {
  for (const candidate of uiAssetCandidates()) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}
