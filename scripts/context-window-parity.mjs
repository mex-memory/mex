#!/usr/bin/env node

/**
 * One-window parity for the lexical prompt recipe.
 *
 * A prompt that fits in one window (at most 40 words) must rank exactly as it did
 * before prompts were cut into windows. This runs the same prompts through a
 * baseline build and the current build (`mex context prompt --lexical --explain`)
 * and compares the injected ids and every candidate's id, score, normalised
 * score, corroboration, identifier boost and gate decision.
 *
 *   node scripts/context-window-parity.mjs \
 *     --baseline C:/path/to/old/dist/cli.js \
 *     --set C:/ws/hono::split/hono-dev.json --set C:/ws/ts::split/ts-dev.json
 *
 * Exit status is 1 if any prompt of at most 40 words differs. Longer prompts are
 * reported (they differ by design).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const options = { baseline: null, current: resolve(SCRIPT_DIR, "..", "dist", "cli.js"), sets: [], limit: 40 };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  const value = () => {
    i += 1;
    if (args[i] === undefined) throw new Error(`${flag} needs a value.`);
    return args[i];
  };
  if (flag === "--baseline") options.baseline = resolve(value());
  else if (flag === "--current") options.current = resolve(value());
  else if (flag === "--limit") options.limit = Number(value());
  else if (flag === "--set") {
    const [workspace, questions] = value().split("::");
    options.sets.push({ workspace: resolve(workspace), questions: resolve(questions) });
  } else throw new Error(`Unknown option ${flag}.`);
}
if (options.baseline === null || options.sets.length === 0) {
  console.error("--baseline <cli.js> and at least one --set <workspace>::<questions.json> are required.");
  process.exit(2);
}

const run = (cli, cwd, prompt) => {
  const result = spawnSync(process.execPath, [cli, "context", "prompt", "--json", "--explain", "--lexical", prompt], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return JSON.parse(result.stdout).data;
};
const key = (data) =>
  JSON.stringify({
    injected: data.injected.map((entry) => entry.id),
    candidates: data.candidates.map((c) => [c.id, c.score, c.norm, c.groups, c.exact, c.decision]),
  });

let identical = 0;
const different = [];
let longIdentical = 0;
let longDifferent = 0;
for (const set of options.sets) {
  for (const question of JSON.parse(readFileSync(set.questions, "utf8"))) {
    const same = key(run(options.baseline, set.workspace, question.prompt)) === key(run(options.current, set.workspace, question.prompt));
    const words = question.prompt.trim().split(/\s+/).length;
    if (words <= options.limit) {
      if (same) identical += 1;
      else different.push(question.id);
    } else if (same) longIdentical += 1;
    else longDifferent += 1;
  }
}
console.log(`Prompts of at most ${options.limit} words: ${identical} identical, ${different.length} different${different.length ? ` (${different.join(", ")})` : ""}.`);
console.log(`Longer prompts: ${longIdentical} identical, ${longDifferent} different (expected to differ).`);
process.exit(different.length === 0 ? 0 : 1);
