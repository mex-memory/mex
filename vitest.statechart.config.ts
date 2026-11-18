import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { STATECHART_LIMITS } from "./packages/hub-contracts/src/statechart.js";
// Let the checker enforce its existing runtime cap and finish child cleanup.
// A shorter test timeout abandons its promise and causes later checks to race.
export default defineConfig({ resolve: { alias: { "@mex/hub-contracts/statechart": resolve("packages/hub-contracts/src/statechart.ts") } }, test: { include: ["src/statechart/__tests__/checker.integration.ts"], maxWorkers: 1, testTimeout: STATECHART_LIMITS.checkerMs + 5_000, env: { MEX_TELEMETRY: "0" } } });
