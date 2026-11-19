// The background loop's graph duties (graph-02), kept out of background.ts:
// wake on an edit instead of waiting for the next poll, apply edits warm,
// queue cold refreshes, and queue the weekly full-rebuild check.

import { readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { RecordWriter } from "../record/index.js";
import type { EnqueueOptions, EnqueueResult } from "../record/jobs.js";
import { recordBuildUsage } from "../record/build-usage.js";
import type { WarmRegistry } from "./warm-registry.js";
import { GRAPH_VERIFY_INTERVAL_MS, readGraphState } from "./jobs.js";

type Queue = (writer: RecordWriter, options: EnqueueOptions) => EnqueueResult;

export class BackgroundGraph {
  private registry: WarmRegistry | undefined;
  private watcher: FSWatcher | undefined;
  private wake: (() => void) | undefined;
  private lastChecks = -Infinity;

  constructor(private readonly writer: RecordWriter, private readonly queue: Queue, private readonly log: (line: string) => void) {
    // An edit touches `index-pending`; waking on it saves up to a poll interval.
    try {
      this.watcher = watch(writer.location.directory, { persistent: false }, (_event, name) => {
        if (name === "index-pending") this.wake?.();
      });
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
    } catch {
      this.watcher = undefined; // the poll still finds every edit
    }
  }

  /** Before the file index consumes the hook's line shifts: note which files changed. */
  async collect(): Promise<void> {
    const directory = this.writer.location.directory;
    const { editsPending } = await import("./warm-registry.js");
    if (!editsPending(directory)) return;
    (await this.warm()).collect(directory);
  }

  /** Publish waiting edits, keep the cap, queue cold refreshes and due checks. */
  async run(now = Date.now()): Promise<void> {
    if (this.registry?.busy) await this.registry.run();
    if (now - this.lastChecks >= 60 * 60_000) {
      this.lastChecks = now;
      try { this.queueDueChecks(now); } catch { /* the next pass retries */ }
    }
  }

  /** Whether the loop must keep running for graph work. */
  get busy(): boolean {
    return this.registry?.busy ?? false;
  }

  /** Sleep up to `ms`, waking early when an edit arrives. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void { clearTimeout(timer); resolve(); }
      this.wake = () => { this.wake = undefined; done(); };
    });
  }

  stop(): void {
    this.registry?.closeAll();
    this.watcher?.close();
  }

  private async warm(): Promise<WarmRegistry> {
    if (this.registry) return this.registry;
    const { WarmRegistry } = await import("./warm-registry.js");
    this.registry = new WarmRegistry({
      queueRefresh: (projectId, checkout) => {
        try { this.queue(this.writer, { kind: "graph-refresh", projectId, params: { checkout } }); } catch { /* the next cooling retries */ }
      },
      noteUsage: (projectId, checkout, result, cpuMs, rssMb, serverRssMb) => {
        if (result.status === "unchanged") return;
        try {
          recordBuildUsage(this.writer.db, {
            projectId, checkout, kind: "warm", files: result.files.length, wallMs: result.ms, cpuMs, peakRssMb: rssMb,
            ...(serverRssMb !== undefined ? { serverRssMb } : {}), result: result.status === "published" ? "ok" : "failed",
          });
        } catch { /* the usage log never stops an edit */ }
      },
      log: this.log,
    });
    return this.registry;
  }

  /** One graph-verify job per project whose last check is more than a week old. */
  private queueDueChecks(now: number): void {
    const projects = join(this.writer.location.directory, "projects");
    let ids: string[] = [];
    try { ids = readdirSync(projects); } catch { return; }
    for (const projectId of ids) {
      const index = join(projects, projectId, "index");
      let pointers: string[] = [];
      try { pointers = readdirSync(join(index, "graph-checkouts")).filter((name) => name.endsWith(".json")); } catch { continue; }
      if (pointers.length === 0) continue;
      const state = readGraphState(index);
      if (state && now - Date.parse(state.checkedAt) < GRAPH_VERIFY_INTERVAL_MS) continue;
      // The checkout built most recently stands for the repository.
      let latest: { root: string; at: string } | undefined;
      for (const name of pointers) {
        try {
          const pointer = JSON.parse(readFileSync(join(index, "graph-checkouts", name), "utf8")) as { root?: string; as_of?: string };
          if (pointer.root && (!latest || (pointer.as_of ?? "") > latest.at)) latest = { root: pointer.root, at: pointer.as_of ?? "" };
        } catch { /* a pointer being replaced */ }
      }
      if (latest) this.queue(this.writer, { kind: "graph-verify", projectId, params: { checkout: latest.root } });
    }
  }
}
