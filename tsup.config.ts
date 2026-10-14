import { defineConfig } from "tsup";

/**
 * Three-config build:
 *  - cli + private graph candidate → executable bundles, no public declarations
 *  - hook → the light `mex-hook` entry agent hosts call per event; split on
 *    its own, so the prompt path's heavy modules (Markdown parser, ranker) live
 *    in a chunk only a prompt loads, and none of it is shared with the CLI
 *  - index → dist/index.js + dist/index.d.ts (library entry consumed via `exports`)
 */
export default defineConfig([
  {
    entry: { cli: "src/cli.ts", "graph-candidate": "src/graph/candidate-entry.ts" },
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
    // Hub contracts are a private workspace package and are intentionally
    // bundled into the published CLI instead of becoming a runtime dependency.
    noExternal: ["@mex/hub-contracts"],
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: { hook: "src/context/hook/entry.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: false,
    // Tool events (read, edit, grep) are the hot path and import only light
    // modules; the prompt handler is reached through a dynamic import, which
    // splitting turns into its own chunk, so its external dependencies (the
    // Markdown toolchain) are not loaded for a tool event.
    splitting: true,
    sourcemap: true,
    dts: false,
    esbuildOptions(options) {
      // Keep the hook's chunks distinguishable from the CLI's in dist/.
      options.chunkNames = "hook-chunk-[hash]";
    },
    banner: {
      js: "#!/usr/bin/env node",
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
