import { defineConfig, configDefaults } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contractsSrc = resolve(dirname(fileURLToPath(import.meta.url)), "packages/hub-contracts/src");

export default defineConfig({
  resolve: {
    alias: {
      "@mex/hub-contracts/statechart": resolve(contractsSrc, "statechart.ts"),
      "@mex/hub-contracts/contact": resolve(contractsSrc, "contact.ts"),
      "@mex/hub-contracts/setup": resolve(contractsSrc, "setup.ts"),
    },
  },
  test: {
    // `.demo/` is a reference clone of the grad-capital demo (code-graph port
    // source, spec §0). It is gitignored and its own tests depend on packages we
    // don't install (`mex-engine-cg`), so exclude it from our suite — we port
    // FROM it, we don't run it.
    exclude: [
      ...configDefaults.exclude,
      ".demo/**",
      // The comparison harness uses Node's built-in test runner and is run via
      // `npm run eval:compare:test`, so Vitest must not collect the same files.
      "evaluate/compare/test/**",
      "evaluate/graph/test/**",
      "scripts/benchmark-telemetry.test.js",
      // The Hub web workspace supplies its own jsdom/CSS configuration and the
      // browser suite is collected by Playwright, not the root Node test run.
      "packages/hub-web/**",
      "test/hub-e2e/**",
      // Eval runs can contain archived revisions with their own test trees.
      // Results are data, never part of the active repository test suite.
      ".mex/eval-results/**",
    ],
    // Tests must NEVER emit real telemetry to PostHog. The dev-repo guard only
    // catches commands run from inside this repo; tests spawn the built CLI in
    // temp dirs where that guard does not fire, so disable telemetry globally.
    // Subprocesses spawned with `{ ...process.env }` inherit this.
    // telemetry.test.ts manages MEX_TELEMETRY itself for its enable-path cases.
    // Likewise, tests must never start a real agent CLI found on PATH: setup
    // finds none while this is set (tests inject fake agents explicitly).
    env: {
      MEX_TELEMETRY: "0",
      MEX_SETUP_BACKGROUND_AGENTS: "0",
    },
    // The root suite opens many independent immutable SQLite snapshots. Keep
    // cross-file concurrency below the platform resource cliff so a busy test
    // runner cannot turn a valid index into a transient CANTOPEN/corrupt read.
    maxWorkers: 4,
    // Real Graph/Wiki/Hub integration scenarios build bounded repositories and
    // databases. This is a hang guard, not a performance budget; numeric timing
    // enforcement belongs to benchmark:release on the pinned runner.
    testTimeout: 15_000,
  },
});
