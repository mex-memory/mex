import { existsSync, readFileSync, statfsSync } from "node:fs";
import { freemem } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GiB = 1024 ** 3;
export function parseVmStat(text) {
  const size = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  const values = ["free", "inactive", "speculative"].map((name) => Number(text.match(new RegExp(`Pages ${name}:\\s+(\\d+)`))?.[1]));
  if (!size || values.some((v) => !Number.isFinite(v))) throw new Error("unrecognized vm_stat output");
  return size * values.reduce((a, b) => a + b, 0);
}
export function parseMeminfo(text) {
  const value = text.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!value) throw new Error("MemAvailable missing from meminfo");
  return Number(value[1]) * 1024;
}
export function availableRam(platform = process.platform) {
  if (platform === "linux") return parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  if (platform === "darwin") {
    const result = spawnSync("vm_stat", [], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`vm_stat failed: ${result.stderr}`);
    return parseVmStat(result.stdout);
  }
  return freemem();
}
export function resourceSnapshot(path) {
  const disk = statfsSync(path);
  return { at: new Date().toISOString(), availableRam: availableRam(), freeDisk: Number(disk.bavail) * Number(disk.bsize) };
}
export async function resourceGuard({ path, label, minRamGB = 4, minDiskGB = 5, pollMs = 5000, snapshot = resourceSnapshot, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = (s) => process.stderr.write(`${s}\n`) }) {
  for (const n of [minRamGB, minDiskGB]) if (!Number.isFinite(n) || n < 0) throw new Error("resource floors must be nonnegative");
  const started = Date.now();
  for (;;) {
    const state = snapshot(path), ready = state.availableRam >= minRamGB * GiB && state.freeDisk >= minDiskGB * GiB;
    log(`[resources] ${label}: RAM ${(state.availableRam / GiB).toFixed(2)} GiB, disk ${(state.freeDisk / GiB).toFixed(2)} GiB; ${ready ? "ready" : "waiting"}`);
    if (ready) return { ...state, waitMs: Date.now() - started, minRamGB, minDiskGB };
    await sleep(pollMs);
  }
}
export function parseProcessTable(text) {
  return text.trim().split(/\r?\n/).map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/))
    .filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, command: m[4] }));
}
export function processTable() {
  if (process.platform !== "win32") {
    const r = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ps failed: ${r.stderr}`);
    return parseProcessTable(r.stdout);
  }
  const source = fileURLToPath(new URL("process-snapshot.cs", import.meta.url)).replaceAll("'", "''");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -Path '${source}'; [EvalProcessSnapshot]::Read() | ConvertTo-Json -Compress`], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`process sampling failed: ${r.stderr}`);
  return [].concat(JSON.parse(r.stdout || "[]")).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, rss: Number(p.WorkingSetSize), command: p.CommandLine ?? "", rssUnavailable: p.RssUnavailable }));
}
export function treeRss(table, rootPid, known = new Set([rootPid])) {
  let changed = true;
  while (changed) { changed = false; for (const p of table) if (known.has(p.ppid) && !known.has(p.pid)) { known.add(p.pid); changed = true; } }
  return table.filter((p) => known.has(p.pid)).reduce((sum, p) => sum + p.rss, 0);
}
// An independent process keeps sampling while the harness waits on synchronous maintenance/test commands.
export function startSampler({ path, csv, rootPid = process.pid, intervalMs = 5000 }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("resource-sampler.mjs", import.meta.url)), String(rootPid), path, csv, String(intervalMs)], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let error = "";
  child.stderr.on("data", (s) => { error += s; });
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  child.on("message", (message) => { if (message === "ready") markReady(true); });
  const done = new Promise((resolve) => {
    child.on("error", (e) => { error += e.message; });
    child.on("close", (code) => { markReady(false); resolve({ code, error: error || null }); });
  });
  let stopped = false;
  return { async stop() {
    if (!stopped) { stopped = true; if (await ready && child.connected) child.send("stop", () => { /* close reports any child failure after both pipes drain */ }); }
    const outcome = await done; return { ...samplerSummary(csv), ...outcome };
  } };
}
export function samplerSummary(csv) {
  if (!existsSync(csv)) return { samples: 0, peakRss: null, minAvailableRam: null, minFreeDisk: null };
  const rows = readFileSync(csv, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",").slice(1).map(Number));
  return { samples: rows.length, peakRss: rows.length ? Math.max(...rows.map((r) => r[0])) : null, minAvailableRam: rows.length ? Math.min(...rows.map((r) => r[1])) : null, minFreeDisk: rows.length ? Math.min(...rows.map((r) => r[2])) : null };
}
