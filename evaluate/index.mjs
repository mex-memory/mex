// Eval harness entry point — `npm run eval`.
//
// Runs the deterministic categories (efficiency + search quality), writes
// results under evaluate/results/, prints a summary, and applies the hard gates
// from thresholds.json. Exits non-zero if any gate fails.
//
// Flags:
//   --root <dir>   subject repo to evaluate (default: this repo)
//   --no-rebuild   skip `mex graph` rebuild (use the existing .mex/graph.db)
//   --no-gate      report only; do not exit non-zero on gate failure

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEfficiency } from "./efficiency.mjs";
import { runSearchQuality } from "./search-quality.mjs";
import { REPO_ROOT } from "./lib/run-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { root: REPO_ROOT, rebuild: true, gate: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = resolve(argv[++i]);
    else if (argv[i] === "--no-rebuild") args.rebuild = false;
    else if (argv[i] === "--no-gate") args.gate = false;
  }
  return args;
}

function checkGates(thresholds, efficiency, search) {
  const failures = [];
  const eff = thresholds.efficiency;
  if (efficiency.summary.medianBaselineToGraphRatio < eff.medianGrepTop3ToScope.min) {
    failures.push(`medianGrepTop3ToScope ${efficiency.summary.medianBaselineToGraphRatio} < ${eff.medianGrepTop3ToScope.min}`);
  }
  const minRecall = Math.min(...efficiency.rows.map((r) => r.expectedRecall));
  if (minRecall < eff.scopeExpectedRecall.min) {
    failures.push(`scopeExpectedRecall ${minRecall} < ${eff.scopeExpectedRecall.min}`);
  }
  if (search.summary.foundRate < thresholds.searchQuality.whereDefinedFoundRate.min) {
    failures.push(`whereDefinedFoundRate ${search.summary.foundRate} < ${thresholds.searchQuality.whereDefinedFoundRate.min}`);
  }
  return failures;
}

const args = parseArgs(process.argv.slice(2));
const thresholds = JSON.parse(readFileSync(join(HERE, "thresholds.json"), "utf-8"));

console.log(`\n[eval] subject: ${args.root}`);
const efficiency = runEfficiency({ root: args.root, rebuild: args.rebuild });
const search = runSearchQuality({ root: args.root });

console.log("\n== Category 1: retrieval efficiency ==");
console.table(efficiency.rows);
console.log("summary:", efficiency.summary);

console.log("\n== Category 2: search quality ==");
console.table(search.rows);
console.log("summary:", search.summary);

const failures = checkGates(thresholds, efficiency, search);
if (failures.length === 0) {
  console.log("\n[eval] all gates passed.\n");
} else {
  console.log(`\n[eval] ${failures.length} gate failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log("");
  if (args.gate) process.exit(1);
}
