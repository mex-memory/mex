import { defineConfig } from "tsup";

/**
 * Two-config build:
 *  - cli  → dist/cli.js   (shebang banner, no .d.ts; consumed by `bin`)
 *  - index → dist/index.js + dist/index.d.ts (library entry consumed via `exports`)
 */
export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: true,
    splitting: false,
    sourcemap: true,
    dts: false,
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
