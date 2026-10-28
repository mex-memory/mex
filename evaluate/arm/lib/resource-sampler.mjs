import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processTable, resourceSnapshot, treeRss } from "./resources.mjs";
const [root, path, csv, interval] = process.argv.slice(2);
const known = new Set([Number(root)]);
let peak = 0;
writeFileSync(csv, "at,rssBytes,availableRamBytes,freeDiskBytes,peakRssBytes\n");
function sample() {
  for (const name of ["context-settle.lock", "push-settle.lock"]) {
    const lock = join(path, ".mex", "local", name);
    try { if (existsSync(lock)) { const pid = Number(readFileSync(lock, "utf8").trim()); if (pid > 0) known.add(pid); } } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const table = processTable(), rss = treeRss(table, Number(root), known), state = resourceSnapshot(path);
  const unavailable = table.filter((p) => known.has(p.pid) && p.rssUnavailable);
  if (unavailable.length) throw new Error(`RSS unavailable for sampled processes: ${unavailable.map((p) => `${p.pid}:${p.command}`).join(", ")}`);
  peak = Math.max(peak, rss);
  appendFileSync(csv, `${state.at},${rss},${state.availableRam},${state.freeDisk},${peak}\n`);
}
sample();
const timer = setInterval(sample, Number(interval));
process.on("message", () => { clearInterval(timer); sample(); process.disconnect(); });
process.on("disconnect", () => { clearInterval(timer); });
if (process.connected) process.send("ready");
