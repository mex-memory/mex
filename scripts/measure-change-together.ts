// Held-out precision of change-together pairs (not a shipped feature).
//
//   Measure:  npx vite-node scripts/measure-change-together.ts -- <repo>@<commit> ... [--refresh 1,400] [--json out.json]
//     The test changes are the newest 400 landed changes before the pinned commit (the default
//     branch's first-parent line, so a merged pull request is one change: what one task touches).
//     Each is scored with pairs mined as MEX mines them: from the 2,000 non-merge commits before
//     it, re-mined every N test changes for each N in --refresh (MEX re-mines when HEAD moves, so
//     1 is the shipped case). Precision is reported per pair kind with a 95% bootstrap interval
//     over changes, with the share of edited files that got a hint. Where pull requests land as
//     merges it also scores learning from the merges' whole diffs, which MEX doesn't do. For
//     comparison it prints the one-shot number of the first version (older 80% of 2,000 non-merge
//     commits learned at once, newest 20% as test, lockfile pairs now left out).
//
//   Tune:     npx vite-node scripts/measure-change-together.ts -- --tune <repo>@<commit> ...
//     The first version's threshold search: never reads the newest 20%; within the older 80% it
//     learns from the oldest three quarters and scores the newest quarter, for every setting in
//     PARAM_GRID. The winner has the highest mean Wilson 95% lower bound across repositories.
//
// Test changes are always counted up to EVALUATION_BULK_FILES files, whatever the learning cap.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  EVALUATION_BULK_FILES, HISTORY_LIMITS, PAIR_PARAMS, PARAM_GRID, heldOutPrecision, parseLog, precisionOn, validationSplit,
  type PairParams,
} from "../src/repo-start/history/mine.js";
import { parseStatusLog, rollingPrecision } from "../src/repo-start/history/measure.js";

const TEST_CHANGES = 400;
const args = process.argv.slice(2).filter(arg => arg !== "--");
const tune = args.includes("--tune");
const valueOf = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const jsonAt = valueOf("--json");
const refresh = (valueOf("--refresh") ?? "1,400").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0);
const targets = args.filter((arg, index) => !arg.startsWith("--") && !["--json", "--refresh"].includes(args[index - 1] ?? "") && arg.includes("@"));
if (!targets.length) {
  console.error("Usage: npx vite-node scripts/measure-change-together.ts -- [--tune] <repo>@<commit> ... [--refresh 1,400] [--json out.json]");
  process.exit(2);
}

const git = (repo: string, gitArgs: string[]) => execFileSync("git", ["-C", repo, "-c", "core.quotePath=off", ...gitArgs], { encoding: "utf8", maxBuffer: 512 << 20 });
const split = (target: string) => { const at = target.lastIndexOf("@"); return { repo: target.slice(0, at), commit: target.slice(at + 1) }; };
/** The first version's input: non-merge commits, newest first. */
const commitsOf = (repo: string, commit: string) =>
  parseLog(git(repo, ["log", "--no-renames", "--no-merges", "--name-only", "--format=%x1e%H", "-n", String(HISTORY_LIMITS.commits), commit]));

let result: unknown;
if (tune) {
  const splits = targets.map(split).map(({ repo, commit }) => ({ repo, commit, ...validationSplit(commitsOf(repo, commit)) }));
  const scored = PARAM_GRID.map((params: PairParams) => {
    const perRepo = splits.map(item => ({ repo: item.repo, ...precisionOn(item.learn, item.validation, params) }));
    return { params, meanLower: perRepo.reduce((sum, item) => sum + item.lower, 0) / perRepo.length, firings: perRepo.reduce((sum, item) => sum + item.firings, 0), perRepo };
  }).sort((a, b) => b.meanLower - a.meanLower || b.firings - a.firings);
  result = { mode: "tune", evaluationBulkFiles: EVALUATION_BULK_FILES, shipped: PAIR_PARAMS, winner: scored[0], top: scored.slice(0, 10), grid: scored.length };
} else {
  result = {
    mode: "measure", parameters: PAIR_PARAMS, evaluationBulkFiles: EVALUATION_BULK_FILES, window: HISTORY_LIMITS.commits, testChanges: TEST_CHANGES,
    repos: targets.map(split).map(({ repo, commit }) => {
      const landed = parseStatusLog(git(repo, ["log", "--first-parent", "--diff-merges=first-parent", "--no-renames", "--name-status", "--format=%x1e%H",
        "-n", String(HISTORY_LIMITS.commits + TEST_CHANGES), commit])).reverse();
      const tests = Array.from({ length: Math.min(TEST_CHANGES, Math.max(0, landed.length - 1)) }, (_, i) => landed.length - Math.min(TEST_CHANGES, landed.length - 1) + i);
      const merges = Number(git(repo, ["rev-list", "--count", "--merges", "--first-parent", `${landed[0]!.hash}..${commit}`]).trim());
      // As MEX mines: the non-merge commits reachable from the change's first parent.
      const shipped = (index: number) => commitsOf(repo, `${landed[index]!.hash}^1`);
      return {
        repo, commit, changes: landed.length, mergesOnMainLine: merges,
        rolling: refresh.map(every => rollingPrecision(landed, tests, { refreshEvery: every, learnAt: shipped })),
        ...(merges > 0 ? { learningFromMergeDiffs: rollingPrecision(landed, tests, { refreshEvery: refresh[0] }) } : {}),
        firstVersion: heldOutPrecision(commitsOf(repo, commit)),
      };
    }),
  };
}
console.log(JSON.stringify(result, null, 2));
if (jsonAt) writeFileSync(jsonAt, `${JSON.stringify(result, null, 2)}\n`);
