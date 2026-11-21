// Warm-path edit latency and memory held between edits, for next2's compiler
// route (OSS-73, M0). Bundled with esbuild against src/ and run with node:
//
//   node_modules/.bin/esbuild scripts/graph-engine-bench/warm-latency.ts --bundle \
//     --platform=node --format=esm --packages=external --outfile=<out>.mjs
//   MEX_HOME=<fresh> node <out>.mjs <repo copy> <file to edit> [edits=20]
//
// Builds the graph, opens a warm checkout, makes 2 warm-up edits and then the
// timed edits, each appending one comment line to the same file (a body-only
// change the warm path accepts). Prints one JSON line.
import { appendFileSync } from "node:fs";
import { join, extname } from "node:path";
import { rebuildGraph } from "../../src/graph/maintenance.js";
import { WarmCheckout } from "../../src/graph/warm.js";
import { childProcessUsage } from "../../src/graph/process-stats.js";

const [root, file, count = "20"] = process.argv.slice(2);
const comment = extname(file) === ".py" ? "# warm edit\n" : "// warm edit\n";
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

await rebuildGraph(root);
const openStarted = performance.now();
let warm = WarmCheckout.open(root);
const openMs = Math.round(performance.now() - openStarted);
const results = [];
for (let i = 0; i < Number(count) + 2; i++) {
  appendFileSync(join(root, file), comment);
  const r = await warm.edit([file]);
  if (i >= 2) results.push(r);
  // A cold edit leaves the checkout to be opened again, as the background
  // process does after the cold refresh it queues.
  if (r.status === "cold") { warm.close(); await rebuildGraph(root); warm = WarmCheckout.open(root); }
}
const nodeRssMb = Math.round(process.memoryUsage().rss / 1048576);
const servers = await childProcessUsage();
const serverRssMb = Math.round(servers.reduce((n, s) => n + (s.rssMb ?? s.peakRssMb ?? 0), 0));
const ms = results.filter((r) => r.status === "published").map((r) => r.ms);
const phaseNames = [...new Set(results.flatMap((r) => Object.keys(r.phases ?? {})))];
console.log(JSON.stringify({
  file, openMs,
  edits: results.length,
  statuses: Object.fromEntries([...new Set(results.map((r) => r.status))].map((s) => [s, results.filter((r) => r.status === s).length])),
  reasons: [...new Set(results.map((r) => r.reason).filter(Boolean))].slice(0, 3),
  p50: ms.length ? percentile(ms, 0.5) : null,
  p90: ms.length ? percentile(ms, 0.9) : null,
  phasesP50: Object.fromEntries(phaseNames.map((p) => [p, percentile(results.map((r) => r.phases?.[p] ?? 0), 0.5)])),
  heldMb: { node: nodeRssMb, servers: serverRssMb, total: nodeRssMb + serverRssMb },
}));
warm.close();
process.exit(0);
