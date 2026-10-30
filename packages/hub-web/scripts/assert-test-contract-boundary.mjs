import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hubContractAliases } from "./contract-aliases.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serveAliases = hubContractAliases(packageRoot, "serve");
const buildAliases = hubContractAliases(packageRoot, "build");
const expectedServeEntries = new Map([
  ["@mex/hub-contracts/statechart", resolve(packageRoot, "../hub-contracts/src/statechart.ts")],
  ["@mex/hub-contracts", resolve(packageRoot, "../hub-contracts/src/index.ts")],
  ["@mex/hub-contracts/ids", resolve(packageRoot, "../hub-contracts/src/ids.ts")],
  ["@mex/hub-contracts/overview", resolve(packageRoot, "../hub-contracts/src/overview.ts")],
  ["@mex/hub-contracts/contact", resolve(packageRoot, "../hub-contracts/src/contact.ts")],
  ["@mex/hub-contracts/setup", resolve(packageRoot, "../hub-contracts/src/setup.ts")],
  ["@mex/hub-contracts/relay", resolve(packageRoot, "../hub-contracts/src/relay.ts")],
]);

for (const [specifier, expected] of expectedServeEntries) {
  const actual = serveAliases[specifier];
  if (actual !== expected || !existsSync(actual)) {
    throw new Error(`Hub tests must resolve ${specifier} from the current contract source.`);
  }
  if (actual.split(sep).includes("dist")) {
    throw new Error(`Hub tests cannot depend on a prebuilt contract artifact: ${relative(packageRoot, actual)}`);
  }
  if (buildAliases[specifier] === actual) {
    throw new Error(`Hub test and production aliases must keep separate source and dist boundaries for ${specifier}.`);
  }
}
