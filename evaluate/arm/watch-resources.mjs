#!/usr/bin/env node
// Samples available RAM, free disk and the memory of every process whose command line matches
// one of the given words, into a CSV, until stopped with Ctrl+C. For runs done by hand
// (`mex setup`, `mex sync`); harness steps sample themselves.
//
//   node evaluate/arm/watch-resources.mjs --out <file.csv> [--path <dir on the disk to watch>] [--match mex,codex,node] [--interval 5]
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { processTable, resourceSnapshot } from "./lib/resources.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : fallback; };
const out = resolve(arg("--out") ?? (() => { throw new Error("--out is required"); })());
const path = resolve(arg("--path", "."));
const words = arg("--match", "mex,codex,node").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
const intervalMs = Math.max(1, Number(arg("--interval", "5"))) * 1000;
const gib = (bytes) => (bytes / 2 ** 30).toFixed(2);

writeFileSync(out, "at,matchedRssBytes,matchedProcesses,largestRssBytes,largestCommand,availableRamBytes,freeDiskBytes\n");
let peak = 0, lowRam = Infinity, lowDisk = Infinity;
function sample() {
  const matched = processTable().filter((p) => p.pid !== process.pid && words.some((w) => String(p.command ?? "").toLowerCase().includes(w)));
  const rss = matched.reduce((sum, p) => sum + (p.rss ?? 0), 0);
  const largest = matched.reduce((a, p) => ((p.rss ?? 0) > (a?.rss ?? -1) ? p : a), null);
  const state = resourceSnapshot(path);
  peak = Math.max(peak, rss); lowRam = Math.min(lowRam, state.availableRam); lowDisk = Math.min(lowDisk, state.freeDisk);
  const command = String(largest?.command ?? "").replace(/[",\r\n]/g, " ").slice(0, 160);
  appendFileSync(out, `${state.at},${rss},${matched.length},${largest?.rss ?? 0},"${command}",${state.availableRam},${state.freeDisk}\n`);
}
sample();
const timer = setInterval(sample, intervalMs);
const stop = () => {
  clearInterval(timer);
  console.log(`peak matched RSS ${gib(peak)} GiB; lowest available RAM ${gib(lowRam)} GiB; lowest free disk ${gib(lowDisk)} GiB; samples in ${out}`);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`sampling every ${intervalMs / 1000} s into ${out}; Ctrl+C to stop`);
