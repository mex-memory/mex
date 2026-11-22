// The background process's warm checkouts (graph-02).
//
// Edits reach the background process as the hook leaves them for the file
// index: a line shift per edited file and the `index-pending` marker. The
// registry reads which files changed from those shifts, keeps a checkout warm
// once an edit arrives for it, and publishes each edit as an overlay. It
// enforces the warm memory cap (the engine processes plus the Node memory the
// warm checkouts hold) by closing the least recently used checkout, closes a
// checkout after 15 minutes without an edit, and queues a cold `graph-refresh`
// once a checkout's edits have been quiet for 2 minutes after the warm path
// went cold for it or it cooled.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childProcessUsage, WARM_GRAPH_SERVER } from "./process-stats.js";
import { GRAPH_SERVER_CAP_MB } from "./sizing.js";
import { readGraphState, type GraphState } from "./jobs.js";
import type { GraphLocation } from "./storage.js";
import type { WarmGraphCheckout, WarmEditResult } from "./warm.js";

export interface WarmRegistrySettings {
  /** Warm memory cap, MB: servers plus their share of Node. */
  capMb: number;
  /** A checkout with no edit for this long closes. */
  coolMs: number;
  /** Edits that need a cold refresh wait this long without another edit. */
  quietMs: number;
  /** How often the servers' memory is sampled. */
  probeMs: number;
}

export const WARM_DEFAULTS: WarmRegistrySettings = {
  capMb: GRAPH_SERVER_CAP_MB,
  coolMs: 15 * 60_000,
  quietMs: 2 * 60_000,
  probeMs: 60_000,
};

export interface WarmHost {
  /** Queue the cold refresh of one checkout (a `graph-refresh` job). */
  queueRefresh(projectId: string, checkout: string): void;
  /** One warm edit's usage, for the usage log. */
  noteUsage?(projectId: string, checkout: string, result: WarmEditResult, cpuMs: number, rssMb: number, serverRssMb?: number): void;
  log?(line: string): void;
  /** Test seam: open a checkout. */
  open?(root: string): Promise<WarmGraphCheckout> | WarmGraphCheckout;
  clock?(): number;
}

interface Waiting { projectId: string; lastEditAt: number }

export class WarmRegistry {
  private readonly warm = new Map<string, { checkout: WarmGraphCheckout; projectId: string }>();
  private readonly pending = new Map<string, { projectId: string; paths: Set<string> }>();
  private readonly waiting = new Map<string, Waiting>();
  private serverRssMb = 0;
  private lastProbe = 0;
  private probing = false;
  private readonly baselineRssMb = process.memoryUsage().rss / 1024 ** 2;

  constructor(private readonly host: WarmHost, private readonly settings: WarmRegistrySettings = WARM_DEFAULTS) {}

  private now(): number {
    return this.host.clock?.() ?? Date.now();
  }

  /**
   * Read which files the hook saw edited, from the line shifts waiting in
   * each project's index folder. Call it before the file-index job consumes
   * them; it removes nothing.
   */
  collect(recordDirectory: string): number {
    let found = 0;
    let projects: string[] = [];
    try { projects = readdirSync(join(recordDirectory, "projects")); } catch { return 0; }
    for (const projectId of projects) {
      const index = join(recordDirectory, "projects", projectId, "index");
      let keys: string[] = [];
      try { keys = readdirSync(join(index, "shifts")); } catch { continue; }
      for (const key of keys) {
        let root: string;
        try { root = (JSON.parse(readFileSync(join(index, "checkouts", `${key}.json`), "utf8")) as { root: string }).root; } catch { continue; }
        let directories: string[] = [];
        try { directories = readdirSync(join(index, "shifts", key)); } catch { continue; }
        for (const directory of directories) {
          let names: string[] = [];
          try { names = readdirSync(join(index, "shifts", key, directory)).filter((name) => name.endsWith(".json")); } catch { continue; }
          for (const name of names) {
            try {
              const shift = JSON.parse(readFileSync(join(index, "shifts", key, directory, name), "utf8")) as { path?: unknown };
              if (typeof shift.path !== "string") continue;
              this.note(projectId, root, [shift.path]);
              found++;
            } catch { /* half written: the next pass reads it */ }
          }
        }
      }
    }
    return found;
  }

  /** Edits to `paths` (relative to `root`, or absolute) in one checkout. */
  note(projectId: string, root: string, paths: readonly string[]): void {
    const entry = this.pending.get(root) ?? { projectId, paths: new Set<string>() };
    for (const path of paths) entry.paths.add(path);
    this.pending.set(root, entry);
  }

  /** Whether anything waits: edits to apply, or a cold refresh to queue later. */
  get busy(): boolean {
    return this.pending.size > 0 || this.waiting.size > 0 || this.warm.size > 0;
  }

  get warmCheckouts(): number {
    return this.warm.size;
  }

  /** Apply waiting edits, cool idle checkouts, keep the cap, queue cold refreshes. */
  async run(): Promise<void> {
    const edits = [...this.pending];
    this.pending.clear();
    for (const [root, { projectId, paths }] of edits) await this.apply(root, projectId, [...paths]);
    const now = this.now();
    for (const [root, entry] of [...this.warm]) {
      if (now - entry.checkout.lastEditAt < this.settings.coolMs) continue;
      this.close(root, "cooled");
      // A refresh after the session writes what the warm path could leave out.
      this.wait(root, entry.projectId, entry.checkout.lastEditAt);
    }
    for (const [root, waiting] of [...this.waiting]) {
      if (now - waiting.lastEditAt < this.settings.quietMs || this.warm.has(root)) continue;
      this.waiting.delete(root);
      this.host.queueRefresh(waiting.projectId, root);
    }
    this.keepCap(now);
  }

  private wait(root: string, projectId: string, lastEditAt: number): void {
    const previous = this.waiting.get(root);
    this.waiting.set(root, { projectId, lastEditAt: Math.max(lastEditAt, previous?.lastEditAt ?? 0) });
  }

  private async apply(root: string, projectId: string, paths: string[]): Promise<void> {
    const now = this.now();
    if (process.env.MEX_GRAPH_STORAGE !== "v5") {
      this.close(root, "cold");
      this.host.log?.(`warm: ${root} stays cold: Schema v4 edits use a normal graph refresh.`);
      this.wait(root, projectId, now);
      return;
    }
    let entry = this.warm.get(root);
    if (!entry) {
      // A repository whose last full-rebuild check differed stays cold.
      const location = await import("./storage.js").then(({ graphLocation }) => graphLocation(root)).catch(() => undefined);
      if (!location) { this.wait(root, projectId, now); return; }
      const state = readGraphState(location.directory);
      if (state?.warm === "off" && await checkDisabled(location, state)) { this.wait(root, projectId, now); return; }
      try {
        const checkout = await (this.host.open?.(root) ?? import("./warm.js").then(({ openWarmCheckout }) => openWarmCheckout(root)));
        entry = { checkout, projectId };
        this.warm.set(root, entry);
        this.host.log?.(`warm: ${root}`);
      } catch (error) {
        this.host.log?.(`warm: ${root} stays cold: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        this.wait(root, projectId, now);
        return;
      }
    }
    const cpu = process.cpuUsage();
    const result = await entry.checkout.edit(paths);
    const used = process.cpuUsage(cpu);
    this.host.noteUsage?.(projectId, root, result, (used.user + used.system) / 1000, process.memoryUsage().rss / 1024 ** 2 + this.serverRssMb, this.serverRssMb || undefined);
    if (result.status === "cold") {
      this.host.log?.(`warm: ${root} went cold: ${result.reason ?? "unknown"}`);
      this.close(root, "cold");
      this.wait(root, projectId, now);
    }
  }

  private close(root: string, why: string): void {
    const entry = this.warm.get(root);
    if (!entry) return;
    this.warm.delete(root);
    try { entry.checkout.close(); } catch { /* closing */ }
    this.host.log?.(`warm: closed ${root} (${why})`);
  }

  /** Sample the servers now and then; over the cap, close the least recently edited. */
  private keepCap(now: number): void {
    if (this.warm.size === 0) { this.serverRssMb = 0; return; }
    if (!this.probing && now - this.lastProbe >= this.settings.probeMs) {
      this.probing = true;
      this.lastProbe = now;
      void childProcessUsage(WARM_GRAPH_SERVER).then((servers) => {
        this.serverRssMb = servers.reduce((sum, server) => sum + (server.rssMb ?? server.peakRssMb), 0);
      }).finally(() => { this.probing = false; });
    }
    const nodeShare = Math.max(0, process.memoryUsage().rss / 1024 ** 2 - this.baselineRssMb);
    if (this.serverRssMb + nodeShare <= this.settings.capMb) return;
    // One checkout per pass, the least recently edited; the next probe tells
    // whether that was enough. Its edits are published already, and its next
    // edit opens it again if there is room.
    const [oldest] = [...this.warm].sort(([, left], [, right]) => left.checkout.lastEditAt - right.checkout.lastEditAt)[0]!;
    const share = this.serverRssMb / this.warm.size;
    this.close(oldest, `over the ${this.settings.capMb} MB warm cap`);
    this.serverRssMb = Math.max(0, this.serverRssMb - share);
    this.lastProbe = 0;
  }

  /** Test seam: the measured server memory. */
  setServerRss(mb: number): void {
    this.serverRssMb = mb;
    this.lastProbe = this.now();
  }

  closeAll(): void {
    for (const root of [...this.warm.keys()]) this.close(root, "stopping");
  }
}

async function checkDisabled(location: GraphLocation, state: GraphState): Promise<boolean> {
  const { openGraphRead } = await import("./overlay-open.js");
  const { readsV5Graph } = await import("./db/v5.js");
  const db = openGraphRead(location.root);
  try { return !db || readsV5Graph(db) === (state.schemaVersion === 5); }
  finally { db?.close(); }
}

/** The marker the hook touches after an edit. */
export function editsPending(recordDirectory: string): boolean {
  return existsSync(join(recordDirectory, "index-pending"));
}
