import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import type { MachineHome } from "@mex/hub-contracts/machine";
import { openHooksReadOnly, openRecordReadOnly, recordLocation } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { homeTimeZone, readHomeMetrics } from "./home-metrics.js";
import { snapshotFields, takeHomeSnapshot, type HomeSnapshot } from "./home-snapshot.js";
import { readStore } from "./read.js";

const METRICS_CACHE_MS = 10_000;
const ZONE_CACHE_LIMIT = 4;
const ACTIVE_MS = 120_000;
const REFRESH_MS = 120_000;
const SIGNAL_CHECK_MS = 15_000;

function refreshSignal(location: LocationOptions): string {
  const jobs = readStore(openRecordReadOnly, location, (reader) => reader?.all(`
    SELECT id,state,finished_at FROM jobs WHERE finished_at IS NOT NULL
      AND state IN ('done','done with gaps','failed','cancelled')
      AND (kind='file-index' OR kind GLOB 'graph-*' OR kind GLOB 'learn*')
    ORDER BY finished_at DESC,id DESC LIMIT 16`));
  const verdict = readStore(openHooksReadOnly, location, (hooks) => hooks?.get("SELECT max(checked_at) AS at FROM verdicts"));
  // Review decisions in the terminal are visible on the same cheap refresh interval.
  const { record } = recordLocation({ ...location, create: false });
  const review = [record, record + "-wal"].map((path) => {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat && `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  });
  return JSON.stringify([jobs, verdict, review]);
}

export function homeActivityFingerprint(location: LocationOptions): string {
  return readStore(openHooksReadOnly, location, (hooks) => JSON.stringify(hooks?.get(`SELECT
    (SELECT max(last_seen_at) FROM sessions) AS seen,(SELECT max(rowid) FROM deliveries) AS delivery`) ?? null));
}

/** In-memory cache scoped to one Hub app and its selected home. */
export class HomeData {
  #metrics = new Map<string, { at: number; value: ReturnType<typeof readHomeMetrics> }>();
  #stop = new AbortController();
  #snapshot: HomeSnapshot | undefined;
  #updatingSince: string | undefined;
  #lastStart: number | undefined;
  #lastFullStart = -Infinity;
  #refreshing: Promise<void> | undefined;
  readonly #instance = randomUUID();
  #lastActivity = -Infinity;
  #lastSignal: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #generation = 0;
  #snapshotGeneration = 0;

  constructor(private readonly location: LocationOptions, private readonly now: () => number) {}

  get generation(): number { return this.#generation; }

  clearMetrics() { this.#metrics.clear(); }

  touch() {
    if (this.#stop.signal.aborted) return;
    this.#lastActivity = this.now();
    if (this.#lastStart !== undefined) this.#schedule();
  }

  getReview() {
    this.touch();
    const now = this.now();
    if (!this.#refreshing && now - this.#lastFullStart >= REFRESH_MS) void this.#refresh(now);
    return {
      snapshot: this.#snapshot, updatingSince: this.#updatingSince, generation: `${this.#instance}:${this.#snapshotGeneration}`,
      ready: this.#refreshing,
    };
  }

  async refreshProject(repoId: string) {
    while (this.#refreshing) await this.#refreshing;
    await this.#refresh(this.now(), undefined, this.#snapshot ? repoId : undefined);
  }

  get(zone: string | undefined): MachineHome {
    const now = this.now();
    this.getReview();
    const tz = homeTimeZone(zone);
    let cached = this.#metrics.get(tz);
    if (!cached || now < cached.at || now - cached.at >= METRICS_CACHE_MS) {
      cached = { at: now, value: readHomeMetrics(this.location, tz, now) };
      this.#metrics.delete(tz);
      if (this.#metrics.size >= ZONE_CACHE_LIMIT) this.#metrics.delete(this.#metrics.keys().next().value!);
      this.#metrics.set(tz, cached);
    }
    return {
      ...cached.value,
      generatedAt: this.#snapshot?.generatedAt ?? new Date(now).toISOString(),
      ...(!this.#snapshot ? { pending: true } : {}),
      ...snapshotFields(this.#snapshot, this.#updatingSince, cached.value.byRepo),
    };
  }

  close() {
    this.#stop.abort();
    clearTimeout(this.#timer);
    this.clearMetrics();
  }

  #schedule() {
    if (this.#timer || this.#stop.signal.aborted) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const now = this.now();
      if (now - this.#lastActivity >= ACTIVE_MS) return;
      if (!this.#updatingSince && now - this.#lastStart! >= SIGNAL_CHECK_MS) {
        const signal = this.#signal();
        if (now - this.#lastFullStart >= REFRESH_MS || (signal !== undefined && signal !== this.#lastSignal)) {
          void this.#refresh(now, signal);
        }
      }
      this.#schedule();
    }, SIGNAL_CHECK_MS);
    this.#timer.unref();
  }

  #signal(): string | undefined {
    try { return refreshSignal(this.location); } catch { return undefined; }
  }

  #refresh(now: number, signal?: string, only?: string) {
    if (this.#stop.signal.aborted) return Promise.resolve();
    this.#lastStart = now;
    if (!only) this.#lastFullStart = now;
    this.#updatingSince = new Date(now).toISOString();
    if (this.#snapshot) this.#generation++;
    this.#refreshing = (async () => {
      try {
        if (signal === undefined) {
          // The first snapshot and its change signals run outside the GET.
          await setImmediate(undefined, { signal: this.#stop.signal });
          signal = this.#signal();
        }
        if (!only) this.#lastSignal = signal ?? this.#lastSignal;
        this.#snapshot = await takeHomeSnapshot(this.location, this.#snapshot, this.now, this.#stop.signal, only);
        this.#snapshotGeneration++;
        this.clearMetrics();
      } catch { /* Keep the last good in-memory snapshot. */ }
      finally {
        this.#updatingSince = undefined;
        this.#refreshing = undefined;
        this.#generation++;
      }
    })();
    this.#schedule();
    return this.#refreshing;
  }
}
