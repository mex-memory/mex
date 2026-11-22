// CPU time and peak memory of this process and of the compiler servers it
// started, for the usage log and the warm compilers' memory cap.
//
// Node reports its own numbers for free (process.resourceUsage). A compiler
// server is another process, so it is probed: Linux reads /proc (cheap and
// exact), Windows asks CIM once for every child of this process (about a
// second, so it is never on an edit's path), macOS uses ps (current, not peak).

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

export interface ProcessUsage {
  cpuMs: number;
  peakRssMb: number;
}

export interface ChildProcessUsage extends ProcessUsage {
  pid: number;
  name: string;
  /** Resident memory now, where the platform reports it apart from the peak. */
  rssMb?: number;
}

/** This process since it started. */
export function ownUsage(): ProcessUsage {
  const usage = process.resourceUsage();
  return {
    cpuMs: Math.round((usage.userCPUTime + usage.systemCPUTime) / 1000),
    // maxRSS is in kilobytes on every platform Node supports.
    peakRssMb: Math.round(usage.maxRSS / 1024),
  };
}

/** The compiler servers among this process's children (tsrs, tsgo). */
export const COMPILER_SERVER = /^(tsrs|tsgo|typescript-go|tsc)(\.exe)?$/iu;
export const WARM_GRAPH_SERVER = /^mex-graph(\.exe)?$/iu;

/**
 * Children of `parentPid` whose executable name matches `name`. Resolves to an
 * empty list when the platform cannot tell; never rejects.
 */
export function childProcessUsage(name: RegExp = COMPILER_SERVER, parentPid = process.pid, timeoutMs = 5_000): Promise<ChildProcessUsage[]> {
  try {
    if (process.platform === "linux") return Promise.resolve(linuxChildren(parentPid).filter((child) => name.test(child.name)));
    if (process.platform === "win32") return windowsChildren(parentPid, timeoutMs).then((all) => all.filter((child) => name.test(child.name)));
    return psChildren(parentPid, timeoutMs).then((all) => all.filter((child) => name.test(child.name)));
  } catch {
    return Promise.resolve([]);
  }
}

function linuxChildren(parentPid: number): ChildProcessUsage[] {
  const ticks = 100; // USER_HZ; every Linux Node supports reports in hundredths.
  const children: ChildProcessUsage[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // The name is in parentheses and may itself contain spaces or ')'.
      const close = stat.lastIndexOf(")");
      const name = stat.slice(stat.indexOf("(") + 1, close);
      const fields = stat.slice(close + 2).split(" ");
      if (Number(fields[1]) !== parentPid) continue;
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const kb = (key: string): number => Number(new RegExp(`^${key}:\\s+(\\d+)`, "mu").exec(status)?.[1] ?? 0);
      children.push({
        pid: Number(entry),
        name,
        cpuMs: Math.round((Number(fields[11]) + Number(fields[12])) * 1000 / ticks),
        peakRssMb: Math.round(kb("VmHWM") / 1024),
        rssMb: Math.round(kb("VmRSS") / 1024),
      });
    } catch {
      // The process exited while it was being read.
    }
  }
  return children;
}

function collect(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (output.length < 1 << 20) output += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(output); });
  });
}

async function windowsChildren(parentPid: number, timeoutMs: number): Promise<ChildProcessUsage[]> {
  // PeakWorkingSetSize and WorkingSetSize are in KB and bytes respectively;
  // UserModeTime and KernelModeTime are in 100 ns units.
  const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Math.trunc(parentPid)}' | `
    + "ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.ProcessId,$_.Name,$_.PeakWorkingSetSize,$_.WorkingSetSize,$_.UserModeTime,$_.KernelModeTime }";
  const output = await collect("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs);
  const children: ChildProcessUsage[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const [pid, name, peakKb, rssBytes, user, kernel] = line.trim().split("|");
    if (!pid || !name || !/^\d+$/u.test(pid)) continue;
    children.push({
      pid: Number(pid),
      name,
      peakRssMb: Math.round(Number(peakKb) / 1024),
      rssMb: Math.round(Number(rssBytes) / 1024 ** 2),
      cpuMs: Math.round((Number(user) + Number(kernel)) / 10_000),
    });
  }
  return children;
}

async function psChildren(parentPid: number, timeoutMs: number): Promise<ChildProcessUsage[]> {
  const output = await collect("ps", ["-A", "-o", "pid=,ppid=,rss=,time=,comm="], timeoutMs);
  const children: ChildProcessUsage[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match || Number(match[2]) !== parentPid) continue;
    const name = match[5]!.trim().split("/").at(-1)!;
    const rssMb = Math.round(Number(match[3]) / 1024);
    children.push({ pid: Number(match[1]), name, rssMb, peakRssMb: rssMb, cpuMs: cpuTime(match[4]!) });
  }
  return children;
}

/** ps's `time` column: [[dd-]hh:]mm:ss[.ff]. */
function cpuTime(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") as [string, string] : ["0", text];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts as [number, number, number];
  return Math.round(((Number(days) * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000);
}

/**
 * Usage of the compiler servers this process closed, summed per build. A
 * compiler adds a probe just before it closes its server; the build awaits
 * them all at the end.
 */
const pendingProbes: Promise<ChildProcessUsage[]>[] = [];
let probesEnabled = false;

/** Probe each compiler server before it closes: the candidate process and warm compilers turn this on. */
export function enableCompilerServerProbes(enabled = true): void {
  probesEnabled = enabled;
}

export function compilerServerProbesEnabled(): boolean {
  return probesEnabled;
}

/** Probe the live compiler servers now; `then` runs once the probe settled. */
export function probeCompilerServers(then?: () => void): void {
  const probe = childProcessUsage().catch(() => [] as ChildProcessUsage[]);
  pendingProbes.push(probe);
  if (then) void probe.finally(then);
}

/** Every probe since the last call: CPU summed, peak the highest one seen. */
export async function settleCompilerServerUsage(): Promise<ProcessUsage | undefined> {
  const probes = pendingProbes.splice(0);
  if (probes.length === 0) return undefined;
  const seen = new Map<number, ChildProcessUsage>();
  for (const children of await Promise.all(probes)) {
    for (const child of children) {
      const previous = seen.get(child.pid);
      if (!previous || child.cpuMs >= previous.cpuMs) seen.set(child.pid, child);
    }
  }
  if (seen.size === 0) return undefined;
  let cpuMs = 0;
  let peakRssMb = 0;
  for (const child of seen.values()) {
    cpuMs += child.cpuMs;
    peakRssMb = Math.max(peakRssMb, child.peakRssMb);
  }
  return { cpuMs, peakRssMb };
}
