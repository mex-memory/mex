import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vitest/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hubContractAliases } from "./scripts/contract-aliases.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const fixtureModuleId = "virtual:mex-hub-fixture-api";
const relayComboboxSource = resolve(packageRoot, "src/components/primitives/combobox.tsx");
const relayComboboxClonePrefix = "\0mex-relay-combobox:";
const relayComboboxDependency = /\/node_modules\/(?:@base-ui\/(?:react|utils)|@floating-ui\/(?:core|dom|react-dom|utils))\//u;

/**
 * Base UI's Combobox makes additional exports in shared popup/navigation modules
 * live. Without an isolated module identity, Rollup hoists that superset into the
 * static chunks used by unrelated workbenches even though the Relay composer is
 * lazy. Clone only the official Combobox's Base/Floating UI dependency graph for
 * production; React and application modules continue to use their normal identity.
 */
function isolateRelayComboboxRuntime(): Plugin {
  return {
    name: "mex-relay-combobox-runtime-isolation",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const cleanImporter = importer.startsWith(relayComboboxClonePrefix)
        ? importer.slice(relayComboboxClonePrefix.length)
        : importer;
      const isRelayComboboxImport = cleanImporter === relayComboboxSource
        || importer.startsWith(relayComboboxClonePrefix);
      if (!isRelayComboboxImport) return null;

      const resolved = await this.resolve(source, cleanImporter, { ...options, skipSelf: true });
      if (!resolved || !relayComboboxDependency.test(resolved.id)) return resolved;
      return {
        ...resolved,
        id: `${relayComboboxClonePrefix}${resolved.id}`,
      };
    },
    load(id) {
      if (!id.startsWith(relayComboboxClonePrefix)) return null;
      return readFileSync(id.slice(relayComboboxClonePrefix.length), "utf8");
    },
  };
}

export default defineConfig(({ command }) => ({
  esbuild: {
    legalComments: "eof",
  },
  plugins: [react(), tailwindcss(), isolateRelayComboboxRuntime()],
  resolve: {
    alias: {
      "@": resolve(packageRoot, "src"),
      ...hubContractAliases(packageRoot, command),
      [fixtureModuleId]: resolve(
        packageRoot,
        command === "build"
          ? "src/api/production-fixture-boundary.ts"
          : "src/dev/fixture-api.ts",
      ),
    },
  },
  build: {
    outDir: "../../dist/hub",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) { if (id.includes("/node_modules/dompurify/")) return "diagram-sanitizer"; },
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    restoreMocks: true,
    clearMocks: true,
  },
}));
