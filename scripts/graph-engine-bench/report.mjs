#!/usr/bin/env node
// Summarize the M0 baseline: node report.mjs <BENCH_DIR> > baseline.json
// Medians across runs; bytes per node uses the built graph before the refresh.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const bench = process.argv[2];
const results = join(bench, "results");
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const out = {};
for (const tool of ["085", "next2"]) {
  const dir = join(results, tool);
  if (!existsSync(dir)) continue;
  for (const repo of readdirSync(dir)) {
    const runs = read(join(dir, repo, "measure.json"));
    if (!runs?.length) continue;
    const ok = runs.filter((r) => r.build.code === 0);
    const first = ok[0] ?? runs[0];
    const stats = first.graph.stats;
    const tables = Object.entries(stats?.tables ?? {}).sort((a, b) => b[1] - a[1]);
    const acc = read(join(dir, repo, "accuracy.json"));
    (out[repo] ??= {})[tool] = {
      runs: runs.length, failed: runs.length - ok.length,
      files: stats?.files, nodes: stats?.nodes, edges: stats?.edges,
      buildS: median(ok.map((r) => r.build.wallMs / 1000)),
      cpuS: median(ok.map((r) => r.build.cpuMs / 1000)),
      peakMb: median(ok.map((r) => r.build.peakTreeMb)),
      diskMb: median(ok.map((r) => r.graph.bytes / 1048576)),
      bytesPerNode: stats?.nodes ? Math.round(first.graph.bytes / stats.nodes) : null,
      refreshS: median(ok.map((r) => (r.refresh?.code === 0 ? r.refresh.wallMs / 1000 : NaN))),
      refreshPeakMb: median(ok.map((r) => (r.refresh?.code === 0 ? r.refresh.peakTreeMb : NaN))),
      topTables: tables.slice(0, 6).map(([name, bytes]) => [name, +(bytes / 1048576).toFixed(1)]),
      accuracy: acc && { precision: acc.precision, recall: acc.recall, recallConcrete: acc.recall_concrete, sites: acc.sites, interfaceSites: acc.interface_sites, edgesJudged: acc.edges_judged, edgesTotal: acc.edges_total, wrong: acc.wrong },
      errors: runs.filter((r) => r.build.code !== 0).map((r) => r.build.stderrTail).slice(0, 1),
    };
  }
}
console.log(JSON.stringify(out, null, 2));
