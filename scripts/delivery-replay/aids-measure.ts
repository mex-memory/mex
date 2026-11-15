// Written aliases, measured on the labelled prompt set (not a shipped feature).
//
//   MEX_HOOK_BINARY=<mex-hook> npx vite-node scripts/delivery-replay/aids-measure.ts -- --qset <dir> --split dev [--output out.json]
//
// Four variants through the shipped learned gate, on the same prompts:
//   none      no aliases
//   derived   the question set's aliases appended to the derived-alias field (how delivery-02 measured them)
//   written   the same aliases as the entries' own `aliases` field, bounded as the entry file bounds them
//   filtered  only the written aliases the capture filter keeps
// Reports helped, wrong and false sends (definitions in evaluate.mjs), net = helped - 2*wrong, and the
// filter's kept and dropped counts overall and by entry kind. The aliases were written by the same model
// family as the prompts, so every gain here is likely inflated; the keep rule needs blind prompts.
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { arg, corpus, metrics, native, rows } from "./evaluate.mjs";
import { filterAids, normalizeAid, withAids } from "../../src/knowledge/aids.js";
import { KNOWLEDGE_LIMITS, type KnowledgeEntry } from "../../src/knowledge/entry.js";

const data = resolve(arg("--qset"));
const split = arg("--split", "dev");
const binary = resolve(process.env.MEX_HOOK_BINARY ?? "");
const labels = [...rows(join(data, "prompts", `${split}.jsonl`))];
if (existsSync(join(data, "prompts", `extra-${split}.jsonl`))) labels.push(...rows(join(data, "prompts", `extra-${split}.jsonl`)));
const asEntry = (e: Record<string, unknown>): KnowledgeEntry => { const { text, ...mex } = e; return { mex, text } as unknown as KnowledgeEntry; };
const flat = (e: KnowledgeEntry) => ({ ...e.mex, text: e.text });
const bounded = (list: string[]) => {
  const out: string[] = [];
  for (const a of list.map(normalizeAid)) if (a && a.length <= KNOWLEDGE_LIMITS.aliasCharacters && !out.some(o => o.toLowerCase() === a.toLowerCase()) && out.length < KNOWLEDGE_LIMITS.aliases) out.push(a);
  return out;
};

const variants: Record<string, Array<{ label: unknown; row: unknown }>> = { none: [], derived: [], written: [], filtered: [] };
const filterCounts = { candidates: 0, kept: 0, dropped: 0, review: 0, byKind: {} as Record<string, { kept: number; dropped: number }>, reasons: {} as Record<string, number> };
for (const repo of [...new Set(labels.map(q => q.repo as string))].sort()) {
  const c = corpus(data, repo);
  const qs = labels.filter(q => q.repo === repo);
  const queries = qs.map(q => ({ id: q.id, text: q.prompt }));
  const base = c.entries.map(asEntry);
  const written = base.map(e => withAids(e, bounded(c.aliases[e.mex.id] ?? []), []));
  // The filter runs entry by entry, as capture would, against what is already kept.
  const kept: KnowledgeEntry[] = base.map(e => withAids(e, [], []));
  for (let i = 0; i < base.length; i++) {
    const candidates = bounded(c.aliases[base[i].mex.id] ?? []).map(text => ({ kind: "alias" as const, text }));
    if (!candidates.length) continue;
    const result = filterAids(kept[i], candidates, kept);
    kept[i] = withAids(kept[i], result.aliases, []);
    for (const v of result.verdicts) {
      filterCounts.candidates++;
      const k = (filterCounts.byKind[base[i].mex.kind] ??= { kept: 0, dropped: 0 });
      if (v.kept) { filterCounts.kept++; k.kept++; } else { filterCounts.dropped++; k.dropped++; filterCounts.reasons[v.reason.replace(/mx_[a-z0-9]+/gu, "<id>")] = (filterCounts.reasons[v.reason.replace(/mx_[a-z0-9]+/gu, "<id>")] ?? 0) + 1; }
      if (v.review) filterCounts.review++;
    }
  }
  const run = (name: string, request: Record<string, unknown>) => {
    const r = native(binary, { queries, gates: [{ learned: true }], ...request });
    qs.forEach((q, i) => variants[name].push({ label: q, row: r.results[i] }));
  };
  run("none", { entries: base.map(flat) });
  run("derived", { entries: base.map(flat), aliases: c.aliases });
  run("written", { entries: written.map(flat), aids: true });
  run("filtered", { entries: kept.map(flat), aids: true });
}
const report = Object.fromEntries(Object.entries(variants).map(([name, all]) => {
  const m = metrics(all.map(x => x.label), all.map(x => x.row), 0);
  return [name, { helped: m.helped, wrong: m.wrong, falseSends: m.falseSends, net: m.helped - 2 * m.wrong, positives: m.positives, mrr: m.mrr }];
}));
const out = { split, prompts: labels.length, note: "aliases and prompts share a model family: gains are likely inflated", report, filter: filterCounts };
console.log(JSON.stringify(out, null, 2));
const output = arg("--output");
if (output) writeFileSync(resolve(output), `${JSON.stringify(out, null, 2)}\n`);
