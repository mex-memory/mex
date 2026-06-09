import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
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
