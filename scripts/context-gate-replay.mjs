#!/usr/bin/env node
// Offline composer comparison. Inputs are JSON jobs with id, index, prompt,
// lexical and optional gold ids. Indexes are JSON only; no database is opened.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => process.argv.slice(2 + i * 2, 4 + i * 2)));
const load = (file) => import(pathToFileURL(resolve(file)).href);
const before = await load(args["--baseline"]);
const after = await load(args["--current"]);
const jobs = JSON.parse(readFileSync(args["--jobs"], "utf8"));
const started = performance.now();
const loaded = args["--semantic"] ? await (await load(args["--semantic"])).loadEmbedder() : { embedder: null };
if (jobs.some((j) => !j.lexical) && !loaded.embedder) throw new Error(loaded.reason ?? "Semantic embedder required");
const modelLoadMs = performance.now() - started;
const cache = new Map();
const rows = [];
try {
  for (const job of jobs) {
    const readStarted = performance.now();
    if (!cache.has(job.index)) cache.set(job.index, JSON.parse(readFileSync(job.index, "utf8")));
    const indexLoadMs = performance.now() - readStarted;
    const index = cache.get(job.index);
    const results = {};
    for (const [name, composer, shortPromptPolicy] of [["before", before, false], ["after", after, false], ["optIn", after, true]]) {
      const scoreStarted = performance.now();
      const { result } = await composer.composePrompt(index, job.prompt, {
        scaffoldRoot: "", embedder: job.lexical ? null : loaded.embedder,
        shortPromptPolicy, liveState: () => () => ({ health: "fresh", locations: [] }),
      });
      results[name] = { ...result, scoringMs: performance.now() - scoreStarted };
    }
    rows.push({ ...job, indexLoadMs, words: job.prompt.trim().split(/\s+/).length, ...results });
  }
} finally { await loaded.embedder?.dispose?.(); }
writeFileSync(args["--output"], JSON.stringify({ modelLoadMs, rows }, null, 1));
for (const name of ["before", "after", "optIn"]) for (const recipe of ["R2w", "R3"]) {
  const selected = rows.filter((r) => r[name].recipe === recipe);
  const reasons = {};
  let sends = 0, goldHits = 0, items = 0, correctItems = 0;
  for (const row of selected) {
    const ids = row[name].injected.filter((e) => e.type !== "pointer").map((e) => e.id);
    sends += Number(ids.length > 0); items += ids.length;
    goldHits += Number(ids.some((id) => row.gold?.includes(id)));
    correctItems += ids.filter((id) => row.gold?.includes(id)).length;
    const reason = row[name].abstention ?? "sent";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  console.log(JSON.stringify({ name, recipe, prompts: selected.length, sends, goldHits, items, correctItems, reasons }));
}
const short = rows.filter((r) => r.words <= 40);
console.log(JSON.stringify({ modelLoadMs, short: short.length, byteIdentical: short.filter((r) => r.before.packet === r.after.packet).length }));
