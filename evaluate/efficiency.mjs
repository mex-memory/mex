// Category 1 — retrieval efficiency.
//
// Reproduces the prior ad-hoc benchmark: for each task compare `graph scope`
// output size against (a) the grep top-3 baseline and (b) the whole source
// corpus, and check expected-symbol recall. Emits JSON + CSV and returns rows
// for the threshold gate.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approxTokens, corpusStats } from "./lib/corpus.mjs";
import { grepTop3 } from "./lib/grep-baseline.mjs";
import { expectedRecall } from "./lib/recall.mjs";
import { buildGraph, parseJsonl, runCli, REPO_ROOT } from "./lib/run-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function runEfficiency({ root = REPO_ROOT, rebuild = true, outDir = join(HERE, "results") } = {}) {
  if (rebuild) buildGraph(root);
  const tasks = JSON.parse(readFileSync(join(HERE, "fixtures", "symbol-tasks.json"), "utf-8"));
  const corpus = corpusStats(root);

  const rows = tasks.map((task) => {
    const { stdout } = runCli(["graph", "scope", task.query], root);
    const parsed = parseJsonl(stdout);
    const graphFacts = parsed.filter((r) => r.type === "fact").length;
    const graphTokens = approxTokens(stdout);
    const { baselineTokens } = grepTop3(root, task.query);
    return {
      id: task.id,
      query: task.query,
      baselineTokens,
      graphFacts,
      graphTokens,
      baselineToGraphRatio: Number((baselineTokens / graphTokens).toFixed(2)),
      corpusToGraphRatio: Number((corpus.sourceTokensApprox / graphTokens).toFixed(2)),
      expectedRecall: expectedRecall(parsed, task.expected),
    };
  });

  const summary = {
    corpus,
    medianBaselineToGraphRatio: Number(median(rows.map((r) => r.baselineToGraphRatio)).toFixed(2)),
    medianCorpusToGraphRatio: Number(median(rows.map((r) => r.corpusToGraphRatio)).toFixed(2)),
    meanExpectedRecall: Number((rows.reduce((s, r) => s + r.expectedRecall, 0) / rows.length).toFixed(3)),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "efficiency.json"), JSON.stringify({ summary, rows }, null, 2));
  const header = "id,query,baselineTokens,graphFacts,graphTokens,baselineToGraphRatio,corpusToGraphRatio,expectedRecall";
  const csv = [header, ...rows.map((r) =>
    [r.id, r.query, r.baselineTokens, r.graphFacts, r.graphTokens, r.baselineToGraphRatio, r.corpusToGraphRatio, r.expectedRecall].join(","),
  )].join("\n");
  writeFileSync(join(outDir, "efficiency.csv"), csv + "\n");

  return { summary, rows };
}
