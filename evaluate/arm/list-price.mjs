#!/usr/bin/env node
// Prices recorded rows at API list rates, after a run on a subscription plan.
//
//   node evaluate/arm/list-price.mjs --runs <output>/runs --input <$/M> --cached-input <$/M> --output <$/M> [--cache-write <$/M>] [--csv <file>]
//
// Rates are dollars per million tokens, looked up on the provider's pricing page on the day and
// recorded with the result. Reasoning tokens are part of output. Two prices per row:
// - billed: uncached input at the input rate, cached input at the cached rate, output at the output rate;
// - neutral: every input token at the input rate, so the prompt cache, and the order sessions ran in,
//   cannot move it.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const rate = (name, required = true) => {
  const value = arg(name);
  if (value === undefined && !required) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} needs a nonnegative dollars-per-million rate`);
  return n;
};
if (!arg("--runs")) throw new Error("--runs <output>/runs is required");
const rates = { input: rate("--input"), cachedInput: rate("--cached-input"), output: rate("--output"), cacheWrite: rate("--cache-write", false) };
const runs = resolve(arg("--runs"));

const rows = readdirSync(runs).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(runs, n), "utf8")))
  .filter((r) => r.metrics && Number.isFinite(r.metrics.input));
const price = (m) => {
  const uncached = Math.max(0, (m.uncachedInput ?? m.input - (m.cacheRead ?? 0)) - (m.cacheWrite ?? 0));
  const billed = (uncached * rates.input + (m.cacheRead ?? 0) * rates.cachedInput + (m.cacheWrite ?? 0) * (rates.cacheWrite || rates.input) + m.output * rates.output) / 1e6;
  const neutral = (m.input * rates.input + m.output * rates.output) / 1e6;
  return { billed, neutral };
};
const priced = rows.map((r) => ({ runId: r.runId, task: r.taskId ?? r.task?.id ?? r.task, arm: r.arm, valid: r.valid === true, correct: r.hiddenTests?.ok === true, processed: r.metrics.processed, ...price(r.metrics) }));

const usd = (n) => `$${n.toFixed(4)}`;
console.log(`Rates ($/M): input ${rates.input}, cached input ${rates.cachedInput}, output ${rates.output}${rates.cacheWrite ? `, cache write ${rates.cacheWrite}` : ""}. Valid rows only.\n`);
console.log("| Arm | Rows | Correct | Processed tokens | Billed $ | Neutral $ |\n|---|---|---|---|---|---|");
const arms = [...new Set(priced.map((p) => p.arm))].sort();
for (const arm of arms) {
  const set = priced.filter((p) => p.arm === arm && p.valid);
  const sum = (k) => set.reduce((s, p) => s + p[k], 0);
  console.log(`| ${arm} | ${set.length} | ${set.filter((p) => p.correct).length} | ${sum("processed")} | ${usd(sum("billed"))} | ${usd(sum("neutral"))} |`);
}
// Paired per task: each MEX arm against files on the same task, valid in both.
const byTask = new Map();
for (const p of priced.filter((p) => p.valid)) byTask.set(p.task, { ...(byTask.get(p.task) ?? {}), [p.arm]: p });
const geomean = (xs) => xs.length ? Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length) : null;
console.log("\n| Arm vs files | Paired tasks | Geomean neutral $ ratio | Geomean processed ratio |\n|---|---|---|---|");
for (const arm of arms.filter((a) => a !== "files")) {
  const pairs = [...byTask.values()].filter((t) => t.files && t[arm] && t.files.neutral > 0 && t.files.processed > 0);
  const cost = geomean(pairs.map((t) => t[arm].neutral / t.files.neutral));
  const tokens = geomean(pairs.map((t) => t[arm].processed / t.files.processed));
  console.log(`| ${arm} | ${pairs.length} | ${cost === null ? "-" : cost.toFixed(3)} | ${tokens === null ? "-" : tokens.toFixed(3)} |`);
}
if (arg("--csv")) {
  writeFileSync(resolve(arg("--csv")), ["runId,task,arm,valid,correct,processed,billedUsd,neutralUsd", ...priced.map((p) => [p.runId, p.task, p.arm, p.valid, p.correct, p.processed, p.billed.toFixed(6), p.neutral.toFixed(6)].join(","))].join("\n") + "\n");
  console.log(`\nPer-row prices written to ${resolve(arg("--csv"))}`);
}
