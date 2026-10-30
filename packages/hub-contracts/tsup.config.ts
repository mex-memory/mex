import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    relay: "src/relay.ts",
    ids: "src/ids.ts",
    overview: "src/overview.ts",
    setup: "src/setup.ts",
    statechart: "src/statechart.ts",
    contact: "src/contact.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
});
