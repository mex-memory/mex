import { defineConfig } from "tsup";

/** Stub optional ink devtools peer so the bundled CLI build succeeds without it. */
const stubReactDevtools = {
  name: "stub-react-devtools-core",
  setup(build: {
    onResolve: (
      args: { filter: RegExp },
      callback: (
        args: { path: string },
      ) => { path: string; namespace: string },
    ) => void;
    onLoad: (
      args: { filter: RegExp; namespace: string },
      callback: () => { contents: string; loader: "js" },
    ) => void;
  }) {
    build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({
      path: args.path,
      namespace: "react-devtools-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "react-devtools-stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

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
    // Bundle all npm deps into dist/cli.js so `node .mex/dist/cli.js` works on
    // Windows without a .mex/node_modules tree (fixes WSL build + Windows runtime).
    noExternal: [/.*/],
    esbuildPlugins: [stubReactDevtools],
    esbuildOptions(options) {
      options.banner = {
        js: [
          "#!/usr/bin/env node",
          "import { createRequire } from 'node:module';",
          "const require = createRequire(import.meta.url);",
        ].join("\n"),
      };
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
