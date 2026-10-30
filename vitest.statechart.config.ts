import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({ resolve: { alias: { "@mex/hub-contracts/statechart": resolve("packages/hub-contracts/src/statechart.ts") } }, test: { include: ["src/statechart/__tests__/checker.integration.ts"], maxWorkers: 1, testTimeout: 15_000, env: { MEX_TELEMETRY: "0" } } });
