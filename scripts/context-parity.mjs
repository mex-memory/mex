#!/usr/bin/env node

/**
 * Parity check for `mex context prompt` against the frozen reference.
 *
 * Runs the built CLI over question files in a workspace and compares, per
 * question, the entity ids it injects with the ids the reference harness
 * injected. Not a unit test: it needs real workspaces (an indexed Wiki and
 * code graph), and for the R3 recipe the semantic extra.
 *
 *   node scripts/context-parity.mjs \
 *     --workspace C:/mex-test-tmp/arm/stop-repro \
 *     --questions split/hono-dev.json --questions split/hono-test.json \
 *     --reference ref-hono-dev.json --reference ref-hono-test.json \
 *     --aliases aliases/hono.json \
 *     --recipe R2w
 *
 * `--reference` files map recipe -> question id -> { ids, top }, as written by
 * the reference's id-dumping runner (the same code path as `run-frozen.cjs`,
 * which prints metrics only). Each reference file pairs with the question file
 * given at the same position. `--aliases` is copied to
 * `<workspace>/.mex/local/context-aliases.json`, the one file this script
 * writes; everything else in the workspace is read-only to it.
 *
 * Recipes: `R2w` runs the CLI with `--lexical`; `R3` runs it without, so it
 * needs the semantic extra (set MEX_HOME to the MEX home that has it). Exit
 * status is 1 if any question differs.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const options = { questions: [], references: [], recipes: [], cli: resolve(SCRIPT_DIR, "..", "dist", "cli.js"), subdir: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) fail(`${flag} needs a value.`);
      return argv[i];
    };
    if (flag === "--workspace") options.workspace = resolve(value());
    else if (flag === "--questions") options.questions.push(resolve(value()));
    else if (flag === "--reference") options.references.push(resolve(value()));
    else if (flag === "--aliases") options.aliases = resolve(value());
    else if (flag === "--recipe") options.recipes.push(value());
    else if (flag === "--cli") options.cli = resolve(value());
    else if (flag === "--subdir") options.subdir = value();
    else if (flag === "--help" || flag === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else fail(`Unknown option ${flag}.`);
  }
  if (options.recipes.length === 0) options.recipes = ["R2w", "R3"];
  if (!options.workspace || options.questions.length === 0) fail("--workspace and at least one --questions are required.");
  if (options.references.length !== options.questions.length) fail("Give one --reference per --questions, in the same order.");
  for (const recipe of options.recipes) if (!["R2w", "R3"].includes(recipe)) fail(`Unknown recipe ${recipe}.`);
  return options;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const options = parseArguments(process.argv.slice(2));

if (options.aliases) {
  const local = join(options.workspace, ".mex", "local");
  mkdirSync(local, { recursive: true });
  copyFileSync(options.aliases, join(local, "context-aliases.json"));
}

// Launching from a subdirectory proves root resolution on the real tree.
const cwd = options.subdir ? join(options.workspace, options.subdir) : options.workspace;
if (!existsSync(cwd)) fail(`${cwd} does not exist.`);

function runPrompt(prompt, recipe) {
  const args = [options.cli, "context", "prompt", prompt, "--json", "--explain"];
  if (recipe === "R2w") args.push("--lexical");
  const started = performance.now();
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const ms = performance.now() - started;
  if (result.status !== 0) throw new Error(`mex context prompt failed (${result.status}): ${result.stderr || result.stdout}`);
  return { envelope: JSON.parse(result.stdout), ms };
}

let totalMismatches = 0;
const summary = [];
for (const recipe of options.recipes) {
  for (let f = 0; f < options.questions.length; f += 1) {
    const questions = JSON.parse(readFileSync(options.questions[f], "utf8"));
    const reference = JSON.parse(readFileSync(options.references[f], "utf8"))[recipe];
    if (!reference) fail(`${options.references[f]} has no ${recipe} section.`);
    let match = 0;
    let injectedQuestions = 0;
    const times = [];
    const mismatches = [];
    for (const question of questions) {
      const expected = reference[question.id]?.ids;
      if (!expected) fail(`${question.id} is missing from the ${recipe} reference.`);
      const { envelope, ms } = runPrompt(question.prompt, recipe);
      times.push(ms);
      const data = envelope.data;
      if (recipe === "R3" && data.recipe !== "R3") {
        fail(`The CLI used ${data.recipe} for an R3 run; install the semantic extra (MEX_HOME=${process.env.MEX_HOME ?? "~"}).`);
      }
      const actual = data.injected.map((entry) => entry.id);
      if (actual.length > 0) injectedQuestions += 1;
      if (JSON.stringify(actual) === JSON.stringify(expected)) match += 1;
      else mismatches.push({ question, expected, actual, data, top: reference[question.id].top });
    }
    totalMismatches += mismatches.length;
    const label = `${recipe} ${options.questions[f].split(/[\\/]/).pop()}`;
    const sorted = times.slice().sort((a, b) => a - b);
    summary.push({
      label,
      match,
      total: questions.length,
      injected: injectedQuestions,
      medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    });
    for (const m of mismatches) {
      console.log(`\nMISMATCH ${label} ${m.question.id}`);
      console.log(`  reference: ${JSON.stringify(m.expected)}`);
      console.log(`  composer : ${JSON.stringify(m.actual)} (abstention ${m.data.abstention ?? "none"})`);
      console.log(`  reference top-4 [id, norm, groups, exact, cos, fused]:`);
      for (const row of m.top) console.log(`    ${JSON.stringify(row)}`);
      console.log("  composer candidates:");
      for (const c of (m.data.candidates ?? []).slice(0, 4)) {
        console.log(`    ${c.rank} ${c.id} norm ${c.norm.toFixed(5)} groups ${c.groups} exact ${c.exact} cos ${c.cos?.toFixed(4) ?? "-"} fused ${c.fused?.toFixed(4) ?? "-"} ${c.decision}`);
      }
    }
  }
}

console.log("\nParity (injected ids identical, in order)");
for (const row of summary) {
  const pct = ((100 * row.match) / row.total).toFixed(1);
  console.log(`  ${row.label.padEnd(28)} ${row.match}/${row.total} (${pct}%)  injected on ${row.injected}  median ${row.medianMs} ms per cold prompt`);
}
process.exit(totalMismatches === 0 ? 0 : 1);
