#!/usr/bin/env node

/**
 * Metrics for the prompt ranking, computed through the built CLI (or the hook
 * entry point), per prompt-length bucket.
 *
 * Each `--set` names a bucket, a workspace (a checkout with an indexed Wiki and
 * code graph) and a question file:
 *
 *   node scripts/context-rank-eval.mjs \
 *     --set short=C:/ws/hono::split/hono-dev.json \
 *     --set long=C:/ws/hono::long/hono-dev.json \
 *     --set verylong=C:/ws/hono::verylong/hono-dev.json \
 *     --aliases C:/ws/hono=aliases/hono.json \
 *     --recipe R2w --recipe R3 [--hook] [--out results.json]
 *
 * A question file is a JSON array of `{ id, prompt, kind, gold: { facts } }`
 * where `kind` is `with-fact`, `no-fact` or `off-topic`. A `noiseFrom` field
 * (the id of another question whose paragraph was pasted into the prompt) lets
 * a send that matches only that paragraph's topic be counted separately.
 *
 * Per bucket and recipe it prints: helped (a with-fact question whose gold entry
 * was injected), injections and how many carried a gold entry, false sends (any
 * injection on a question without a fact), and the median wall time of a cold
 * process. `--hook` times the hook entry point (`dist/hook.js`, the real prompt
 * event) instead of `mex context prompt`. `--aliases <workspace>=<file>` copies
 * the alias overlay into the workspace first (the one file this script writes).
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { sets: [], aliases: [], recipes: [], hook: false, dist: resolve(SCRIPT_DIR, "..", "dist") };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) fail(`${flag} needs a value.`);
      return argv[i];
    };
    if (flag === "--set") {
      const text = value();
      const eq = text.indexOf("=");
      if (eq < 0) fail("--set bucket=workspace::questions.json");
      const bucket = text.slice(0, eq);
      const [workspace, questions] = text.slice(eq + 1).split("::");
      if (!workspace || !questions) fail("--set bucket=workspace::questions.json");
      options.sets.push({ bucket, workspace: resolve(workspace), questions: resolve(questions) });
    } else if (flag === "--aliases") {
      const text = value();
      const at = text.lastIndexOf("=");
      options.aliases.push({ workspace: resolve(text.slice(0, at)), file: resolve(text.slice(at + 1)) });
    } else if (flag === "--recipe") options.recipes.push(value());
    else if (flag === "--hook") options.hook = true;
    else if (flag === "--dist") options.dist = resolve(value());
    else if (flag === "--out") options.out = resolve(value());
    else if (flag === "--help" || flag === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else fail(`Unknown option ${flag}.`);
  }
  if (options.sets.length === 0) fail("At least one --set is required.");
  if (options.recipes.length === 0) options.recipes = ["R2w", "R3"];
  for (const recipe of options.recipes) if (!["R2w", "R3"].includes(recipe)) fail(`Unknown recipe ${recipe}.`);
  return options;
}

const options = parseArguments(process.argv.slice(2));

for (const { workspace, file } of options.aliases) {
  const local = join(workspace, ".mex", "local");
  mkdirSync(local, { recursive: true });
  copyFileSync(file, join(local, "context-aliases.json"));
}

/** One cold prompt: the ids it injected and its wall time. */
function runPrompt(workspace, prompt, recipe) {
  const started = performance.now();
  if (options.hook) {
    const result = spawnSync(process.execPath, [join(options.dist, "hook.js")], {
      cwd: workspace,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, session_id: `rank-eval-${process.pid}-${Math.random().toString(36).slice(2)}`, cwd: workspace }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: workspace, ...(recipe === "R2w" ? { MEX_HOOK_LEXICAL: "1" } : {}) },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const ms = performance.now() - started;
    const ids = [...result.stdout.matchAll(/mex wiki show (mx_[A-Z0-9]+)/g)].map((m) => m[1]);
    return { ids: [...new Set(ids)], ms };
  }
  const args = [join(options.dist, "cli.js"), "context", "prompt", "--json", "--explain", ...(recipe === "R2w" ? ["--lexical"] : []), prompt];
  const result = spawnSync(process.execPath, args, { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const ms = performance.now() - started;
  if (result.status !== 0) throw new Error(`mex context prompt failed (${result.status}): ${result.stderr || result.stdout}`);
  const data = JSON.parse(result.stdout).data;
  if (recipe === "R3" && data.recipe !== "R3") fail(`The CLI used ${data.recipe} for an R3 run; install the semantic extra (MEX_HOME=${process.env.MEX_HOME ?? "~"}).`);
  return { ids: data.injected.map((entry) => entry.id), ms };
}

const median = (xs) => {
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : Math.round(sorted[Math.floor(sorted.length / 2)]);
};

const results = {};
for (const recipe of options.recipes) {
  const perBucket = {};
  for (const set of options.sets) {
    const questions = JSON.parse(readFileSync(set.questions, "utf8"));
    const byId = new Map(questions.map((q) => [q.id, q]));
    const c = (perBucket[set.bucket] ??= { helped: 0, withFact: 0, injections: 0, goldInjections: 0, noiseInjections: 0, falseSends: 0, noFact: 0, noiseFalseSends: 0, times: [], items: {} });
    for (const question of questions) {
      const { ids, ms } = runPrompt(set.workspace, question.prompt, recipe);
      c.times.push(ms);
      const gold = new Set(question.gold?.facts ?? []);
      const noiseGold = new Set(byId.get(question.noiseFrom)?.gold?.facts ?? []);
      const noise = ids.filter((id) => !gold.has(id) && noiseGold.has(id)).length;
      c.items[`${set.workspace}:${question.id}`] = ids;
      if (question.kind === "with-fact") {
        c.withFact += 1;
        const hits = ids.filter((id) => gold.has(id)).length;
        if (hits > 0) c.helped += 1;
        c.injections += ids.length;
        c.goldInjections += hits;
        c.noiseInjections += noise;
      } else {
        c.noFact += 1;
        if (ids.length > 0) {
          c.falseSends += 1;
          c.injections += ids.length;
          c.noiseInjections += noise;
          if (noise === ids.length) c.noiseFalseSends += 1;
        }
      }
    }
  }
  results[recipe] = perBucket;
}

const pct = (a, b) => (b === 0 ? "-" : `${Math.round((100 * a) / b)}%`);
console.log(`\nPrompt ranking through the ${options.hook ? "hook entry point" : "CLI"} (cold process per prompt)`);
for (const [recipe, perBucket] of Object.entries(results)) {
  for (const [bucket, c] of Object.entries(perBucket)) {
    const adjInj = c.injections - c.noiseInjections;
    console.log(
      `  ${recipe.padEnd(4)} ${bucket.padEnd(9)} helped ${c.helped}/${c.withFact}  injections ${c.injections}, with a gold entry ${c.goldInjections} (${pct(c.goldInjections, c.injections)}`
        + `${c.noiseInjections ? `; ${pct(c.goldInjections, adjInj)} without the ${c.noiseInjections} that match only a pasted paragraph` : ""})`
        + `  false sends ${c.falseSends}/${c.noFact}${c.noiseFalseSends ? ` (${c.noiseFalseSends} only the pasted paragraph)` : ""}`
        + `  median ${median(c.times)} ms`,
    );
  }
}
if (options.out) writeFileSync(options.out, JSON.stringify(results, null, 1));
