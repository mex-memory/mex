// Category 2 — search quality.
//
// Black-box smoke test for `graph query`, independent of source payload. The
// committed gate is `where-defined` foundRate + rank (deterministic, needs no
// hand-labeling). who-calls / what-calls fan-out is reported for visibility;
// labeled recall/MRR sets are a documented follow-up.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl, runCli, REPO_ROOT } from "./lib/run-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function runSearchQuality({ root = REPO_ROOT, outDir = join(HERE, "results") } = {}) {
  const tasks = JSON.parse(readFileSync(join(HERE, "fixtures", "symbol-tasks.json"), "utf-8"));

  const rows = tasks.map((task) => {
    const expected = task.expected[0];
    const wd = parseJsonl(runCli(["graph", "query", "where-defined", task.query], root).stdout);
    const results = wd.filter((r) => r.type === "result");
    const rank = results.findIndex((r) => r.name === expected || String(r.qualifiedName ?? "").includes(expected));
    const whoCalls = parseJsonl(runCli(["graph", "query", "who-calls", task.query], root).stdout).filter((r) => r.type === "result").length;
    const whatCalls = parseJsonl(runCli(["graph", "query", "what-calls", task.query], root).stdout).filter((r) => r.type === "result").length;
    return {
      id: task.id,
      query: task.query,
      whereDefinedResults: results.length,
      found: rank >= 0,
      rank: rank >= 0 ? rank + 1 : null,
      whoCallsCount: whoCalls,
      whatCallsCount: whatCalls,
    };
  });

  const foundRate = Number((rows.filter((r) => r.found).length / rows.length).toFixed(3));
  const summary = { foundRate };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "search-quality.json"), JSON.stringify({ summary, rows }, null, 2));
  const header = "id,query,whereDefinedResults,found,rank,whoCallsCount,whatCallsCount";
  const csv = [header, ...rows.map((r) =>
    [r.id, r.query, r.whereDefinedResults, r.found, r.rank ?? "", r.whoCallsCount, r.whatCallsCount].join(","),
  )].join("\n");
  writeFileSync(join(outDir, "search-quality.csv"), csv + "\n");

  return { summary, rows };
}
