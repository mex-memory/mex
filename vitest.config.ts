import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // `.demo/` is a reference clone of the grad-capital demo (code-graph port
    // source, spec §0). It is gitignored and its own tests depend on packages we
    // don't install (`mex-engine-cg`), so exclude it from our suite — we port
    // FROM it, we don't run it.
    exclude: [...configDefaults.exclude, ".demo/**"],
    // Tests must NEVER emit real telemetry to PostHog. The dev-repo guard only
    // catches commands run from inside this repo; tests spawn the built CLI in
    // temp dirs where that guard does not fire, so disable telemetry globally.
    // Subprocesses spawned with `{ ...process.env }` inherit this.
    // telemetry.test.ts manages MEX_TELEMETRY itself for its enable-path cases.
    env: {
      MEX_TELEMETRY: "0",
    },
  },
});
