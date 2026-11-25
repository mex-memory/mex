import { statSync, watch, type FSWatcher } from "node:fs";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { takeKnowledgeSnapshot, type KnowledgeSnapshot } from "./knowledge-snapshot.js";

const REFRESH_MS = 120_000;
const SIGNAL_MS = 15_000;
const MAX_WATCHES = 128;

// The WAL also changes for the terminal's writes and the native hooks. This is
// a cheap hint, with the periodic sweep covering dropped filesystem signals.
function fingerprint(location: LocationOptions): string {
  const { record, hooks } = recordLocation({ ...location, create: false });
  return [record, hooks].flatMap((path) => [path, path + "-wal"]).map((path) => {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat && `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  }).join(";");
}

export class KnowledgeData {
  #stop = new AbortController();
  #watchers = new Map<string, FSWatcher>();
  #dirty = false;
  #snapshot: KnowledgeSnapshot | undefined;
  #updatingSince: string | undefined;
  #lastStart = -Infinity;
  #lastActivity = -Infinity;
  #lastSignal: string | undefined;
  #generation = 0;
  #timer: NodeJS.Timeout | undefined;
  #refreshing: Promise<void> | undefined;

  constructor(readonly location: LocationOptions, private readonly now: () => number, private readonly env?: NodeJS.ProcessEnv) {}

  get generation() { return this.#generation; }

  get() {
    this.touch();
    if (!this.#refreshing && this.now() - this.#lastStart >= REFRESH_MS) void this.#refresh();
    return {
      snapshot: this.#snapshot, generation: this.#generation, updatingSince: this.#updatingSince,
      generatedAt: this.#snapshot?.generatedAt ?? new Date(this.now()).toISOString(),
    };
  }

  touch() {
    this.#lastActivity = this.now();
    if (this.#lastStart !== -Infinity) {
      if (!this.#watchers.size) this.#watch();
      this.#schedule();
    }
  }

  async refreshProject(repoId: string) {
    while (this.#refreshing) await this.#refreshing;
    // A write can be the first Knowledge request to this worker.
    await this.#refresh(this.#snapshot && new Set([repoId]));
  }

  close() {
    this.#stop.abort();
    clearTimeout(this.#timer);
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }

  #schedule() {
    if (this.#timer || this.#stop.signal.aborted) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.now() - this.#lastActivity >= REFRESH_MS) {
        for (const watcher of this.#watchers.values()) watcher.close();
        this.#watchers.clear();
        return;
      }
      if (!this.#refreshing && (this.#dirty || this.#signal() !== this.#lastSignal || this.now() - this.#lastStart >= REFRESH_MS)) {
        void this.#refresh();
      }
      this.#schedule();
    }, SIGNAL_MS);
    this.#timer.unref();
  }

  #signal() {
    try { return fingerprint(this.location); } catch { return this.#lastSignal; }
  }

  #refresh(only?: ReadonlySet<string>): Promise<void> {
    if (this.#stop.signal.aborted) return Promise.resolve();
    this.#lastStart = this.now();
    this.#updatingSince = new Date(this.#lastStart).toISOString();
    this.#refreshing = (async () => {
      try {
        if (!only) {
          this.#lastSignal = this.#signal();
          this.#dirty = false;
        }
        this.#snapshot = await takeKnowledgeSnapshot(this.location, this.#snapshot, this.now, this.#stop.signal, this.env, only);
        this.#generation++;
        this.#watch();
      } catch {
        if (!this.#snapshot) this.#snapshot = {
          generatedAt: new Date(this.now()).toISOString(), projects: new Map(), partial: "Knowledge couldn’t be read. Try refreshing.",
        };
      } finally {
        this.#updatingSince = undefined;
        this.#refreshing = undefined;
      }
    })();
    this.#schedule();
    return this.#refreshing;
  }

  #watch() {
    const wanted = new Set<string>();
    for (const project of this.#snapshot?.projects.values() ?? []) {
      for (const path of project.watch) {
        if (wanted.size >= MAX_WATCHES) break;
        wanted.add(path);
      }
    }
    for (const [path, handle] of this.#watchers) if (!wanted.has(path)) {
      handle.close();
      this.#watchers.delete(path);
    }
    for (const path of wanted) {
      if (this.#watchers.has(path)) continue;
      try {
        const handle = watch(path, { persistent: false }, () => { this.#dirty = true; });
        this.#watchers.set(path, handle);
        handle.on("error", () => { handle.close(); this.#watchers.delete(path); this.#dirty = true; });
      } catch { /* The periodic sweep also notices changes. */ }
    }
  }
}
