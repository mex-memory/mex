// OSS-73 warm edit latency and held RSS, in a disposable checkout.
// Bundle like storage-parity.ts. Set MEX_GRAPH_ENGINE to the release binary,
// MEX_HOME to an empty graph home and MEX_BENCH_CLI to the built dist/cli.js.
//   node --expose-gc dist/graph-warm-latency.mjs <repo copy> <file> [edits=24]
// MEX_WARM_EDIT selects append, prepend, call, export or mixed.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openWarmCheckout, type WarmEditResult } from "../../src/graph/warm.js";
import { benchmarkFiles, changeExport, commentFor, insertCall } from "./edit-cases.js";
import { childProcessUsage, WARM_GRAPH_SERVER } from "../../src/graph/process-stats.js";

const [checkout, file, count = "24"] = process.argv.slice(2);
if (!checkout || !file || !Number.isInteger(Number(count)) || Number(count) < 20 || !process.env.MEX_HOME) {
  throw new Error("Pass a disposable repo, its edit path, at least 20 edits and an empty MEX_HOME.");
}
const root = resolve(checkout);
const cli = resolve(process.env.MEX_BENCH_CLI ?? "dist/cli.js");
const minFree = 2.5 * 1024 ** 3;
function checkDisk(starting = false) {
  const volume = process.platform === "darwin" ? "/System/Volumes/Data" : root;
  const stat = statfsSync(volume);
  const minimum = starting && file === benchmarkFiles.novu ? 4 * 1024 ** 3 : minFree;
  if (stat.bavail * stat.bsize < minimum) throw new Error("The warm benchmark ran out of its disk budget.");
}
checkDisk(true);
const comment = commentFor(file);
const mode = process.env.MEX_WARM_EDIT ?? "append";
const kinds = ["append", "prepend", "call", "export"] as const;
if (mode !== "mixed" && !kinds.some(kind => kind === mode)) throw new Error(`Unknown edit mode ${mode}`);
const editFile = (index: number) => {
  const path = join(root, file);
  const kind = mode === "mixed" ? kinds[index % kinds.length] : mode;
  if (kind === "append") appendFileSync(path, comment);
  else {
    const before = readFileSync(path, "utf8");
    const after = kind === "prepend" ? comment + before
      : kind === "call" ? insertCall(file, before)
      : changeExport(file, before);
    writeFileSync(path, after);
  }
};
const round = (n: number) => Math.round(n * 10) / 10;
const summary = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
  return { p50: round(p50), p95: round(sorted[Math.ceil(0.95 * sorted.length) - 1]!) };
};
const rebuild = JSON.parse(execFileSync(process.execPath, [cli, "graph", "rebuild", "--json"], {
  cwd: root, env: { ...process.env, MEX_TELEMETRY: "0", MEX_OFFLINE: "1", DO_NOT_TRACK: "1" },
  encoding: "utf8", timeout: file === benchmarkFiles.novu ? 240_000 : 120_000, maxBuffer: 4 * 1024 ** 2,
}));
if (rebuild.status?.schemaVersion !== 5) throw new Error("The latency harness requires a v5 publication.");
checkDisk();
globalThis.gc?.();
const initialNodeRss = process.memoryUsage().rss / 1024 ** 2;
const openStarted = performance.now();
const warm = await openWarmCheckout(root);
const openMs = round(performance.now() - openStarted);
const results: WarmEditResult[] = [];
let maxMixedMiB = 0;
const held = async () => {
  globalThis.gc?.();
  const node = process.memoryUsage().rss / 1024 ** 2;
  const servers = await childProcessUsage(WARM_GRAPH_SERVER);
  if (servers.length !== 1) throw new Error(`Expected one resident engine, found ${servers.length}.`);
  const engine = servers[0]!.rssMb ?? servers[0]!.peakRssMb;
  return {
    node: round(node), nodeBeforeOpen: round(initialNodeRss), nodeDelta: round(Math.max(0, node - initialNodeRss)),
    engine: round(engine), total: round(node + engine), enginePlusNodeDelta: round(engine + Math.max(0, node - initialNodeRss)),
  };
};
try {
  for (let i = 0; i < Number(count) + 2; i++) {
    editFile(i);
    const result = await warm.edit([file]);
    if (result.status !== "published") throw new Error(`Edit ${i + 1} returned ${result.status}: ${result.reason ?? ""}`);
    if (i >= 2) results.push(result);
    if (mode === "mixed") maxMixedMiB = Math.max(maxMixedMiB, (await held()).enginePlusNodeDelta);
    checkDisk();
  }
  console.log(JSON.stringify({
    file, edit: mode, openMs, edits: results.length, published: results.length,
    mexMs: summary(results.map(result => result.ms)),
    engineMs: summary(results.map(result => result.phases.engine!)),
    heldMiB: await held(),
    ...(mode === "mixed" ? { maxMixedMiB } : {}),
  }));
} finally { warm.close(); }
