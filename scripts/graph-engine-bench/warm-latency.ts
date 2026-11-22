// OSS-73 warm edit latency and held RSS, in a disposable checkout.
// Bundle like storage-parity.ts. Set MEX_GRAPH_ENGINE to the release binary,
// MEX_HOME to an empty graph home and MEX_BENCH_CLI to the built dist/cli.js.
//   node --expose-gc dist/graph-warm-latency.mjs <repo copy> <file> [edits=24]
// MEX_WARM_EDIT=prepend adds the comment line at the top of the file instead,
// which moves every declaration below it, as an edit inside the file does.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { openWarmCheckout, type WarmEditResult } from "../../src/graph/warm.js";
import { childProcessUsage, WARM_GRAPH_SERVER } from "../../src/graph/process-stats.js";

const [checkout, file, count = "24"] = process.argv.slice(2);
if (!checkout || !file || !Number.isInteger(Number(count)) || Number(count) < 20 || !process.env.MEX_HOME) {
  throw new Error("Pass a disposable repo, its edit path, at least 20 edits and an empty MEX_HOME.");
}
const root = resolve(checkout);
const cli = resolve(process.env.MEX_BENCH_CLI ?? "dist/cli.js");
const minFree = 2.5 * 1024 ** 3;
function checkDisk() {
  const volume = process.platform === "darwin" ? "/System/Volumes/Data" : root;
  const stat = statfsSync(volume);
  if (stat.bavail * stat.bsize < minFree) throw new Error("The warm benchmark ran out of its disk budget.");
}
checkDisk();
const comment = extname(file) === ".py" ? "# warm edit\n" : "// warm edit\n";
const prepend = process.env.MEX_WARM_EDIT === "prepend";
const editFile = () => {
  const path = join(root, file);
  if (prepend) writeFileSync(path, comment + readFileSync(path, "utf8"));
  else appendFileSync(path, comment);
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
  encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 ** 2,
}));
if (rebuild.status?.schemaVersion !== 5) throw new Error("The latency harness requires a v5 publication.");
checkDisk();
globalThis.gc?.();
const initialNodeRss = process.memoryUsage().rss / 1024 ** 2;
const openStarted = performance.now();
const warm = await openWarmCheckout(root);
const openMs = round(performance.now() - openStarted);
const results: WarmEditResult[] = [];
try {
  for (let i = 0; i < Number(count) + 2; i++) {
    editFile();
    const result = await warm.edit([file]);
    if (result.status !== "published") throw new Error(`Edit ${i + 1} returned ${result.status}: ${result.reason ?? ""}`);
    if (i >= 2) results.push(result);
    checkDisk();
  }
  globalThis.gc?.();
  const node = process.memoryUsage().rss / 1024 ** 2;
  const servers = await childProcessUsage(WARM_GRAPH_SERVER);
  if (servers.length !== 1) throw new Error(`Expected one resident engine, found ${servers.length}.`);
  const engine = servers[0]!.rssMb ?? servers[0]!.peakRssMb;
  console.log(JSON.stringify({
    file, edit: prepend ? "prepend" : "append", openMs, edits: results.length, published: results.length,
    mexMs: summary(results.map(result => result.ms)),
    engineMs: summary(results.map(result => result.phases.engine!)),
    heldMiB: {
      node: round(node), nodeBeforeOpen: round(initialNodeRss), nodeDelta: round(Math.max(0, node - initialNodeRss)),
      engine: round(engine), total: round(node + engine),
    },
  }));
} finally { warm.close(); }
