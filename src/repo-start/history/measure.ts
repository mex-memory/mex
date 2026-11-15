/**
 * Held-out measurement of change-together pairs, as an agent would meet them (not a shipped
 * feature; scripts/measure-change-together.ts runs it).
 *
 * Rolling origin: every test change is scored with pairs mined from the WINDOW changes just
 * before it, re-mined every `refreshEvery` changes, so the measure matches how often MEX
 * re-reads history. A pair fires when the change touches A and B still exists then; it hits
 * when the change touches B too. Firings are counted per pair kind, because test/code pairs
 * and parallel copies are easy and would hide how good the other pairs are.
 */
import { changeTogether, EVALUATION_BULK_FILES, HISTORY_LIMITS, historyGenerated, type Commit, type PairKind, type PairParams, PAIR_PARAMS } from "./mine.js";

/** A landed change with what happened to each path: A(dded), M(odified), D(eleted). */
export interface StatusChange { hash: string; files: string[]; deleted: string[]; }

/** `git log --name-status --format=%x1e%H`, newest first. Renames are off, so a rename is D + A. */
export function parseStatusLog(text: string): StatusChange[] {
  const out: StatusChange[] = [];
  for (const record of text.split("\x1e")) {
    const lines = record.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const [hash, ...rows] = lines;
    if (!hash || !/^[0-9a-f]{40,64}$/u.test(hash)) continue;
    const files = new Set<string>(), deleted = new Set<string>();
    for (const row of rows) {
      const tab = row.indexOf("\t");
      if (tab < 0) continue;
      const status = row.slice(0, tab), path = row.slice(tab + 1);
      files.add(path);
      if (status.startsWith("D")) deleted.add(path);
    }
    out.push({ hash, files: [...files], deleted: [...deleted] });
  }
  return out;
}

export interface KindCount { firings: number; hits: number; }
export interface RollingResult {
  window: number; refreshEvery: number; tests: number;
  kinds: Record<PairKind | "all", KindCount & { precision: number | null; low: number | null; high: number | null }>;
  /** Share of edited files (in counted test changes) that got at least one hint. */
  coverage: number;
  hintsPerChange: number;
}

const KINDS: Array<PairKind | "all"> = ["test", "mirror", "related", "all"];

/** A seeded generator, so a bootstrap interval is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

/**
 * Score `tests` (indices into `oldestFirst`) with pairs mined from the `window` changes before
 * each. 95% intervals resample whole changes, since the firings of one change aren't independent.
 */
export function rollingPrecision(oldestFirst: StatusChange[], tests: number[], options: {
  window?: number; refreshEvery?: number; params?: PairParams; resamples?: number;
  /** What to learn from before test change `index`; by default the `window` changes before it. */
  learnAt?: (index: number) => Commit[];
} = {}): RollingResult {
  const window = options.window ?? HISTORY_LIMITS.commits, refreshEvery = options.refreshEvery ?? 1, params = options.params ?? PAIR_PARAMS;
  // When each path was last deleted and last added or changed, to know if it exists at a point.
  const deletedAt = new Map<string, number[]>(), touchedAt = new Map<string, number[]>();
  oldestFirst.forEach((change, index) => {
    for (const path of change.files) {
      const target = change.deleted.includes(path) ? deletedAt : touchedAt;
      let list = target.get(path);
      if (!list) target.set(path, list = []);
      list.push(index);
    }
  });
  const lastBefore = (list: number[] | undefined, index: number) => {
    let found = -1;
    if (list) for (const at of list) { if (at < index) found = at; else break; }
    return found;
  };
  const exists = (path: string, index: number) => lastBefore(deletedAt.get(path), index) <= lastBefore(touchedAt.get(path), index);

  const perChange: Array<Record<PairKind | "all", KindCount>> = [];
  let edited = 0, hinted = 0, hints = 0, rules = new Map<string, Array<{ b: string; kind: PairKind }>>(), minedAt = -Infinity;
  for (const index of tests) {
    const change = oldestFirst[index]!;
    if (change.files.length < 1 || change.files.length > EVALUATION_BULK_FILES) continue;
    if (index - minedAt >= refreshEvery) {
      const learn: Commit[] = options.learnAt?.(index) ?? oldestFirst.slice(Math.max(0, index - window), index);
      const generated = new Set(historyGenerated(learn));
      rules = new Map();
      for (const pair of changeTogether(learn, path => exists(path, index), params, path => generated.has(path))) {
        let list = rules.get(pair.a);
        if (!list) rules.set(pair.a, list = []);
        list.push({ b: pair.b, kind: pair.kind });
      }
      minedAt = index;
    }
    const files = new Set(change.files);
    const counts = Object.fromEntries(KINDS.map(kind => [kind, { firings: 0, hits: 0 }])) as Record<PairKind | "all", KindCount>;
    for (const a of change.files) {
      const fired = rules.get(a) ?? [];
      edited++;
      if (fired.length) hinted++;
      for (const { b, kind } of fired) {
        const hit = files.has(b) ? 1 : 0;
        counts[kind].firings++; counts[kind].hits += hit;
        counts.all.firings++; counts.all.hits += hit;
        hints++;
      }
    }
    perChange.push(counts);
  }

  const total = (sample: Array<Record<PairKind | "all", KindCount>>, kind: PairKind | "all") =>
    sample.reduce((sum, counts) => ({ firings: sum.firings + counts[kind].firings, hits: sum.hits + counts[kind].hits }), { firings: 0, hits: 0 });
  const next = random(20261115), resamples = options.resamples ?? 2000;
  const draws = Array.from({ length: resamples }, () => Array.from({ length: perChange.length }, () => perChange[Math.floor(next() * perChange.length)]!));
  const kinds = Object.fromEntries(KINDS.map(kind => {
    const { firings, hits } = total(perChange, kind);
    const precisions = draws.map(sample => total(sample, kind)).filter(sum => sum.firings > 0).map(sum => sum.hits / sum.firings).sort((x, y) => x - y);
    const pick = (q: number) => precisions.length ? Math.round(precisions[Math.min(precisions.length - 1, Math.floor(q * precisions.length))]! * 1000) / 1000 : null;
    return [kind, { firings, hits, precision: firings ? Math.round((hits / firings) * 1000) / 1000 : null, low: pick(0.025), high: pick(0.975) }];
  })) as RollingResult["kinds"];
  return {
    window, refreshEvery, tests: perChange.length, kinds,
    coverage: edited ? Math.round((hinted / edited) * 1000) / 1000 : 0,
    hintsPerChange: perChange.length ? Math.round((hints / perChange.length) * 100) / 100 : 0,
  };
}
