// Held-out precision of change-together pairs (knowledge-04's measure; not a
// shipped feature). For each repository it reads the newest 2,000 non-merge
// commits ending at a pinned commit (newest first).
//
//   Measure:  npx vite-node scripts/measure-change-together.ts -- <repo>@<commit> ... [--json out.json]
//     Learns pairs from the older 80% with the shipped parameters and counts,
//     over every firing in the newest 20%, whether B changed when A did.
//
//   Tune:     npx vite-node scripts/measure-change-together.ts -- --tune <repo>@<commit> ... [--json out.json]
//     Never reads the newest 20%. Within the older 80% it learns from the
//     oldest three quarters and scores the newest quarter, for every setting in
//     PARAM_GRID. The winner has the highest mean, across repositories, of the
//     Wilson 95% lower bound of validation precision; ties go to more firings.
//
// Test commits are always counted up to EVALUATION_BULK_FILES files, whatever
// the learning cap, so changing a parameter can't make the test easier.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  EVALUATION_BULK_FILES, HISTORY_LIMITS, PAIR_PARAMS, PARAM_GRID, heldOutPrecision, parseLog, precisionOn, validationSplit,
  type Commit, type PairParams,
} from "../src/repo-start/history/mine.js";

const args = process.argv.slice(2).filter(arg => arg !== "--");
const tune = args.includes("--tune");
const jsonAt = args.indexOf("--json");
const targets = args.filter((arg, index) => !arg.startsWith("--") && (jsonAt < 0 || index !== jsonAt + 1) && arg.includes("@"));
if (!targets.length) {
  console.error("Usage: npx vite-node scripts/measure-change-together.ts -- [--tune] <repo>@<commit> ... [--json out.json]");
  process.exit(2);
}

function history(target: string): { repo: string; commit: string; commits: Commit[] } {
  const at = target.lastIndexOf("@");
  const repo = target.slice(0, at), commit = target.slice(at + 1);
  const log = execFileSync("git", ["-C", repo, "-c", "core.quotePath=off", "log", "--no-renames", "--no-merges", "--name-only", "--format=%x1e%H", "-n", String(HISTORY_LIMITS.commits), commit], {
    encoding: "utf8", maxBuffer: 256 << 20,
  });
  return { repo, commit, commits: parseLog(log) };
}

const repos = targets.map(history);
let result: unknown;
if (tune) {
  const splits = repos.map(({ repo, commit, commits }) => ({ repo, commit, ...validationSplit(commits) }));
  const scored = PARAM_GRID.map((params: PairParams) => {
    const perRepo = splits.map(split => ({ repo: split.repo, ...precisionOn(split.learn, split.validation, params) }));
    return { params, meanLower: perRepo.reduce((sum, item) => sum + item.lower, 0) / perRepo.length, firings: perRepo.reduce((sum, item) => sum + item.firings, 0), perRepo };
  }).sort((a, b) => b.meanLower - a.meanLower || b.firings - a.firings);
  result = { mode: "tune", evaluationBulkFiles: EVALUATION_BULK_FILES, shipped: PAIR_PARAMS, winner: scored[0], top: scored.slice(0, 10), grid: scored.length };
} else {
  result = { mode: "measure", parameters: PAIR_PARAMS, evaluationBulkFiles: EVALUATION_BULK_FILES, split: "older 80% learn, newest 20% test",
    repos: repos.map(({ repo, commit, commits }) => ({ repo, commit, commits: commits.length, ...heldOutPrecision(commits) })) };
}
console.log(JSON.stringify(result, null, 2));
if (jsonAt >= 0 && args[jsonAt + 1]) writeFileSync(args[jsonAt + 1]!, `${JSON.stringify(result, null, 2)}\n`);
