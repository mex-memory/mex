// Count deterministic intent-shortcut activations on development prompts.
import { join, resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { arg, rows } from "./evaluate.mjs";
const data = resolve(arg("--qset")),
  output = resolve(arg("--output"));
const labels = rows(join(data, "prompts", "dev.jsonl"));
if (existsSync(join(data, "prompts", "extra-dev.jsonl"))) {
  labels.push(...rows(join(data, "prompts", "extra-dev.jsonl")));
}
const words = {
    changing: ["replace", "migrate", "remove", "rename", "deprecate"],
    reproducing: ["reproduce", "repro"]
  },
  counts = {
    changing: 0,
    reproducing: 0,
    either: 0
  };
for (const q of labels) {
  const ws = new Set(q.prompt.toLowerCase().match(/[a-z]+/g) ?? []),
    changing = words.changing.some(w => ws.has(w)),
    reproducing = words.reproducing.some(w => ws.has(w)) || q.prompt.toLowerCase().includes("failing test");
  counts.changing += Number(changing);
  counts.reproducing += Number(reproducing);
  counts.either += Number(changing || reproducing);
}
const result = {
  queries: labels.length,
  definition: "Shortcut activation frequency on dev prompts, not intent accuracy: no gold intent labels exist.",
  counts,
  rates: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n / labels.length]))
};
writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
