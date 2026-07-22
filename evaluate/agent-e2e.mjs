// Category 3 — end-to-end agent eval (`npm run eval:e2e`).
//
// Runs each variant (minimal vs source) against the natural-language tasks and
// measures the metrics that actually decide the default --detail: accumulated
// tokens across ALL tool calls, follow-up `graph get` calls, Read/Grep fallbacks,
// and rubric correctness. The winner is the variant with the best correctness at
// the lowest total tokens — NOT the smallest first response.
//
// Model-agnostic: uses the deterministic scripted reference driver by default.
// Plug a real model with `--driver <module>` (default-exports (variant) => driver).
//
// Flags: --root <dir>, --driver <module>, --rebuild
//
// NOTE: with the scripted driver, readGrepFallbacks is always 0 by construction —
// only a real model driver exercises fallback behavior. Treat scripted numbers as
// an idealized token-cost baseline, not a correctness verdict.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VARIANTS } from "./lib/variants.mjs";
import { makeTools, summarizeLog } from "./lib/tools.mjs";
import { loadDriverFactory } from "./lib/driver.mjs";
import { grade } from "./lib/grade.mjs";
import { buildGraph, REPO_ROOT } from "./lib/run-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { root: REPO_ROOT, driver: undefined, rebuild: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = resolve(argv[++i]);
    else if (argv[i] === "--driver") args.driver = resolve(argv[++i]);
    else if (argv[i] === "--rebuild") args.rebuild = true;
  }
  return args;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = JSON.parse(readFileSync(join(HERE, "fixtures", "nl-tasks.json"), "utf-8"));
  const driverFactory = await loadDriverFactory(args.driver);
  if (args.rebuild) buildGraph(args.root);

  const rows = [];
  const perVariant = {};

  for (const variant of Object.values(VARIANTS)) {
    const driver = driverFactory(variant);
    const variantRows = [];
    for (const task of tasks) {
      const tools = makeTools(args.root, variant);
      const { answer } = await driver(task, tools);
      const metrics = summarizeLog(tools.log);
      const g = grade(answer, task.rubric);
      const row = { variant: variant.id, task: task.id, ...metrics, correct: g.correct };
      rows.push(row);
      variantRows.push(row);
    }
    perVariant[variant.id] = {
      meanTotalTokens: Math.round(mean(variantRows.map((r) => r.totalTokens))),
      correctRate: Number((variantRows.filter((r) => r.correct).length / variantRows.length).toFixed(3)),
      meanGetCalls: Number(mean(variantRows.map((r) => r.getCalls)).toFixed(2)),
      meanReadGrepFallbacks: Number(mean(variantRows.map((r) => r.readGrepFallbacks)).toFixed(2)),
    };
  }

  console.log(`\n[eval:e2e] subject: ${args.root}  driver: ${args.driver ?? "scripted (reference)"}\n`);
  console.table(rows);
  console.log("\n== per-variant summary ==");
  console.table(perVariant);

  // Winner: highest correctness, tie-broken by lowest accumulated tokens.
  const ranked = Object.entries(perVariant).sort(
    (a, b) => b[1].correctRate - a[1].correctRate || a[1].meanTotalTokens - b[1].meanTotalTokens,
  );
  const [winner] = ranked[0];
  console.log(`\n[eval:e2e] lowest-cost variant at held correctness: ${winner}`);
  if (!args.driver) {
    console.log("[eval:e2e] scripted reference driver — token baseline only; run --driver <model> for a correctness/fallback verdict.");
  }

  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "agent-e2e.json"), JSON.stringify({ perVariant, rows }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
