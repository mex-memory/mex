import { defineConfig } from "tsup";

/**
 * Two-config build:
 *  - cli + private graph candidate → executable bundles, no public declarations
 *  - index → dist/index.js + dist/index.d.ts (library entry consumed via `exports`)
 */
export default defineConfig([
  { entry: { runtime: "src/statechart/helper.ts" }, format: ["esm"], target: "node22", outDir: "skills/mex-statechart/scripts", minify: true, outExtension: () => ({ js: ".mjs" }), clean: false, splitting: false, dts: false, noExternal: ["@mex/hub-contracts", "zod"] },
  {
    entry: { cli: "src/cli-bootstrap.ts", "graph-candidate": "src/graph/candidate-entry.ts", "setup-graph": "src/setup/next-graph-entry.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: true,
    // Split so modules reached only through dynamic import() — the Ink TUI,
    // React, the TypeScript compiler — stay in their own chunks. With one
    // bundle, esbuild hoists every external import to the top of cli.js and
    // each command, even --version, paid to load them.
    splitting: true,
    sourcemap: true,
    dts: false,
    // Bundle the private contracts and read dependencies to reduce per-process
    // module resolution. Preserve the dependency overlay during bundling.
    noExternal: [
      "@mex/hub-contracts", "glob", "yaml", "zod", "chalk", "commander",
      "unified", "remark-parse", "remark-frontmatter", "unist-util-visit",
      "simple-git", "cross-spawn",
    ],
    esbuildOptions(options) { options.preserveSymlinks = true; },
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __mexCreateRequire } from 'node:module';\nvar require = __mexCreateRequire(import.meta.url);",
    },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    // clean: false here — the CLI build above already cleans dist on each run,
    // and we don't want the library build to wipe the CLI artifacts.
    clean: false,
    splitting: false,
    sourcemap: true,
    dts: true,
  },
]);
