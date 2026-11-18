/**
 * Concurrency, and D10's targets at their real scale.
 *
 * Nothing before P10 touched either. Two separate obligations:
 *
 * ## Concurrency
 *
 * §21 does not name it, but a tool people run from a terminal while an editor
 * extension reads the same scaffold is concurrent whether or not anyone
 * planned for it. Four questions, each with a test: two readers at once; a read
 * during a rebuild; an index published while a reader holds the old file open;
 * and whether a second writer waits or fails.
 *
 * The last one found a real gap. The index has been WAL-mode since P3 with **no
 * `busy_timeout`**, which means a connection that finds the database locked
 * fails immediately with `SQLITE_BUSY` instead of waiting — so any genuine
 * contention surfaced as a hard error rather than a pause. The graph's own
 * opener has set `busy_timeout = 5000` since it was written, with a comment
 * insisting it come first. The wiki now does the same.
 *
 * ## Characterization at D10's scale
 *
 * `perf.test.ts` runs a tenth-scale corpus, while this file can run **5,000
 * entities across 1,000 files**, D10's actual numbers. Timings here are emitted
 * as characterization only. Release budgets are enforced by the pinned Ubuntu
 * benchmark; a shared unit-test worker is not a stable performance environment.
 *
 * The corpus is generated into a temp directory and never committed (finding
 * 50). Deterministic assertions prove the operation and incremental-read
 * contracts; measurements are printed for diagnostics without making the
 * result depend on host speed or scheduler contention.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUlidGenerator } from "../../model/ulid.js";
import { rebuildWikiIndex } from "../rebuild.js";
import { refreshWikiIndex } from "../refresh.js";
import { openWikiIndex } from "../open.js";
import { openWikiQuery } from "../../query/session.js";
import { wikiGet, wikiList, wikiNeighborhood, wikiSearch } from "../../service/read.js";

/** D10's calibration targets, in milliseconds. */
const D10 = {
  entities: 5_000,
  files: 1_000,
  rebuild: 5_000,
  refresh: 50,
  get: 10,
  list: 50,
  related: 50,
};

/**
 * Whether to build D10's full corpus, or a fifth of it.
 *
 * The full 5,000-entity build is ~19s of solid CPU, and adding that to the
 * shared worker pool pushed four unrelated tests past their timeouts and one
 * absolute perf ceiling past its threshold — finding 52.4 happening again, to
 * the phase that quoted it. Making the *other* tests looser to accommodate this
 * one would be exactly the wrong trade.
 *
 * So the default is a fifth of the corpus, which still catches an accidental
 * O(n²) — that is orders of magnitude and visible at any honest scale — and
 * `MEX_WIKI_SCALE=1` runs D10's real numbers. Following P6's precedent for the
 * real-scaffold gate: one **unconditional** test that reads an environment
 * variable, rather than `.skip` or `it.runIf`, both of which move the
 * suite-wide skip count that several gates depend on.
 *
 * The measurements in the handoff are from a full-scale run.
 */
const FULL_SCALE = process.env["MEX_WIKI_SCALE"] === "1";
const CORPUS = FULL_SCALE
  ? { files: D10.files, entities: D10.entities }
  : { files: D10.files / 5, entities: D10.entities / 5 };

const SCALE_TIMEOUT = 300_000;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows holds SQLite files open a moment past close.
    }
  }
});

/**
 * Generate a scaffold of `files` files carrying `entities` entities.
 *
 * Generated, never committed: a 5,000-entity corpus in the repository would be
 * megabytes of synthetic prose for one test, and a test that regenerates a
 * committed fixture races every other suite reading it (finding 50).
 */
function generateScaffold(files: number, entities: number): { root: string; ids: string[] } {
  const root = mkdtempSync(join(tmpdir(), "mex-scale-"));
  roots.push(root);
  mkdirSync(join(root, "context"), { recursive: true });

  const nextId = createUlidGenerator();
  const ids: string[] = [];
  const perFile = Math.ceil(entities / files);
  let made = 0;

  for (let index = 0; index < files && made < entities; index += 1) {
    const blocks: string[] = [];
    for (let inner = 0; inner < perFile && made < entities; inner += 1) {
      const id = `mx_${nextId()}`;
      ids.push(id);
      // A relation to the previous entity, so the graph is connected and
      // `related` has something to traverse rather than measuring an empty walk.
      const relation =
        ids.length > 1 ? `relations:\n  - type: depends_on\n    target: ${ids[ids.length - 2]}\n` : "";
      blocks.push(
        `<!-- mex:entity\nid: ${id}\ntype: component\nstatus: promoted\nrevision: 1\n` +
          `title: Component ${made}\nsummary: Handles concern number ${made}.\n${relation}-->\n` +
          `## Component ${made}\n\nThis component owns concern ${made}. It is described in enough\n` +
          `prose that the full-text index has something of realistic length to\n` +
          `store, rather than a single line that would make search unrealistically\n` +
          `cheap to measure.\n\n`,
      );
      made += 1;
    }
    writeFileSync(join(root, "context", `area-${String(index).padStart(4, "0")}.md`), blocks.join(""), "utf-8");
  }
  return { root, ids };
}

function millis(body: () => void): number {
  const started = performance.now();
  body();
  return performance.now() - started;
}

describe("concurrency", () => {
  function indexed(): string {
    const { root } = generateScaffold(20, 100);
    rebuildWikiIndex({ scaffoldRoot: root });
    return root;
  }

  it("serves two readers over one index at the same time", () => {
    const root = indexed();
    const first = openWikiQuery(join(root, "wiki.db"));
    const second = openWikiQuery(join(root, "wiki.db"));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    try {
      // Interleaved rather than sequential: a lock taken by the first and held
      // would show up here and not in two runs one after the other.
      const a = first.value.list({ limit: 10 });
      const b = second.value.list({ limit: 10 });
      const c = first.value.list({ limit: 10 });
      expect(a.items.map((entity) => entity.id)).toEqual(b.items.map((entity) => entity.id));
      expect(c.items.map((entity) => entity.id)).toEqual(a.items.map((entity) => entity.id));
    } finally {
      first.value.close();
      second.value.close();
    }
  });

  it("sets a busy timeout on every connection it opens", () => {
    // The gap this file found. Without it a second connection meeting a lock
    // fails immediately rather than waiting, so ordinary contention becomes a
    // visible error. Asserted through the pragma rather than by trying to
    // provoke a race, which would be timing-dependent and flaky by design.
    const root = indexed();
    const opened = openWikiIndex(join(root, "wiki.db"), { readOnly: false });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const [row] = opened.index.db.prepare("PRAGMA busy_timeout").all() as Array<{ timeout: number }>;
      expect(row?.timeout).toBe(5000);
    } finally {
      opened.index.close();
    }
  });

  it("refuses a republish while a reader holds the index, rather than crashing or corrupting", () => {
    // The finding this file was written to look for, and the answer is not the
    // comfortable one: on Windows a reader holding the live index also holds
    // its `-wal`, and publish must delete that before renaming — a surviving
    // WAL belonging to a replaced database is a corruption vector.
    //
    // So the swap cannot happen, and the two acceptable outcomes are "it
    // waits" or "it refuses cleanly". It refuses: a typed diagnostic, and the
    // live index left exactly as it was. What is *not* acceptable, and what it
    // did before this phase, is a raw EPERM escaping to the caller.
    const root = indexed();
    const reader = openWikiQuery(join(root, "wiki.db"));
    expect(reader.ok).toBe(true);
    if (!reader.ok) return;
    try {
      const before = reader.value.list({ limit: 5 }).items.length;
      expect(before).toBeGreaterThan(0);

      const rebuilt = rebuildWikiIndex({ scaffoldRoot: root });

      if (rebuilt.diagnostics.some((entry) => /open in another process/.test(entry.message))) {
        // The Windows path. The old index still answers, which is the half
        // that matters: refusing must not also break what was already working.
        expect(rebuilt.entityCount).toBe(0);
        expect(reader.value.list({ limit: 5 }).items).toHaveLength(before);
      } else {
        // The POSIX path, where unlinking an open file is ordinary and the
        // reader keeps its snapshot.
        expect(rebuilt.entityCount).toBe(100);
        expect(reader.value.list({ limit: 5 }).items).toHaveLength(before);
      }
    } finally {
      reader.value.close();
    }
  });

  it("republishes cleanly once the reader has let go", () => {
    // The other half: the refusal above must be about the lock and nothing
    // else, so the same rebuild has to succeed the moment the handle closes.
    const root = indexed();
    const reader = openWikiQuery(join(root, "wiki.db"));
    expect(reader.ok).toBe(true);
    if (!reader.ok) return;
    reader.value.list({ limit: 5 });
    reader.value.close();

    const rebuilt = rebuildWikiIndex({ scaffoldRoot: root });
    expect(rebuilt.entityCount).toBe(100);
    expect(rebuilt.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("answers reads correctly while a refresh is in flight against the same index", () => {
    const root = indexed();
    const reader = openWikiQuery(join(root, "wiki.db"));
    expect(reader.ok).toBe(true);
    if (!reader.ok) return;
    try {
      const path = join(root, "context", "area-0000.md");
      writeFileSync(path, `${readFileSync(path, "utf-8")}\nAn appended sentence.\n`, "utf-8");

      const refreshed = refreshWikiIndex({ scaffoldRoot: root, changed: ["context/area-0000.md"] });
      if (!refreshed.ok) {
        // Windows cannot replace an index while this reader holds it open.
        expect(process.platform).toBe("win32");
        expect(refreshed.diagnostic).toMatchObject({
          code: "WIKI_INDEX_REBUILD_REQUIRED",
          message: expect.stringMatching(/open in another process/),
        });
      } else {
        expect(refreshed.ok).toBe(true);
      }

      // The reader was open across the write and still answers rather than
      // throwing SQLITE_BUSY — which is what the busy timeout buys.
      expect(reader.value.list({ limit: 5 }).items.length).toBeGreaterThan(0);
    } finally {
      reader.value.close();
    }
    expect(refreshWikiIndex({ scaffoldRoot: root, changed: ["context/area-0000.md"] }).ok).toBe(true);
  });

  it("keeps two independent scaffolds independent", () => {
    // Two `mex wiki` processes are usually two *different* scaffolds. A shared
    // module-level connection or path cache would show up here.
    const first = indexed();
    const second = indexed();
    const a = wikiList({ scaffoldRoot: first, limit: 5 });
    const b = wikiList({ scaffoldRoot: second, limit: 5 });
    expect(a.data.entities.length).toBeGreaterThan(0);
    expect(b.data.entities.length).toBeGreaterThan(0);
    // Different generated ids, so a cache keyed on nothing would collide.
    expect(a.data.entities[0]!.id).not.toBe(b.data.entities[0]!.id);
  });
});

describe("D10's workload, at D10's scale", () => {
  it(
    "builds, refreshes and queries D10’s corpus",
    () => {
      const { root, ids } = generateScaffold(CORPUS.files, CORPUS.entities);

      const rebuildMs = millis(() => {
        const result = rebuildWikiIndex({ scaffoldRoot: root });
        // A rebuild that indexed nothing would be impressively fast.
        expect(result.entityCount).toBe(CORPUS.entities);
        expect(result.fileCount).toBe(CORPUS.files);
      });

      const refreshMs = millis(() => {
        const result = refreshWikiIndex({ scaffoldRoot: root, changed: ["context/area-0000.md"] });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.unchanged).toEqual(["context/area-0000.md"]);
      });

      const target = ids[Math.floor(ids.length / 2)]!;
      const getMs = millis(() => {
        expect(wikiGet({ scaffoldRoot: root, id: target }).data.entity).not.toBeNull();
      });
      const listMs = millis(() => {
        expect(wikiList({ scaffoldRoot: root, limit: 50 }).data.entities.length).toBeGreaterThan(0);
      });
      const searchMs = millis(() => {
        expect(wikiSearch({ scaffoldRoot: root, text: "concern", limit: 50 }).data.hits.length).toBeGreaterThan(0);
      });
      const relatedMs = millis(() => {
        expect(wikiNeighborhood({ scaffoldRoot: root, id: target, depth: 2, limit: 50 }).data).not.toBeNull();
      });

      // Printed, because the handoff records the measurements and a threshold
      // that passes tells you nothing about how close it came.
      process.stdout.write(
        `\n  D10 at ${FULL_SCALE ? "full" : "one-fifth"} scale ` +
          `(${CORPUS.entities} entities / ${CORPUS.files} files) — ` +
          `rebuild ${rebuildMs.toFixed(0)}ms (target ${D10.rebuild}) · ` +
          `refresh ${refreshMs.toFixed(1)}ms (${D10.refresh}) · get ${getMs.toFixed(1)}ms (${D10.get}) · ` +
          `list ${listMs.toFixed(1)}ms (${D10.list}) · search ${searchMs.toFixed(1)}ms (${D10.list}) · ` +
          `related ${relatedMs.toFixed(1)}ms (${D10.related})\n`,
      );

    },
    SCALE_TIMEOUT,
  );

  it(
    "refreshes only the selected changed file",
    () => {
      // Source-body reads and parse progress state the incremental contract
      // directly. A wall-clock ratio varies with the host and scheduler; a
      // refresh that falls back to a full rebuild must read or schedule more
      // than this one selected file and fails deterministically here.
      const { root } = generateScaffold(CORPUS.files, CORPUS.entities);
      expect(rebuildWikiIndex({ scaffoldRoot: root }).entityCount).toBe(CORPUS.entities);

      const target = "context/area-0000.md";
      const targetAbsolute = join(root, "context", "area-0000.md");
      writeFileSync(targetAbsolute, `${readFileSync(targetAbsolute, "utf-8")}\nChanged after rebuild.\n`, "utf-8");

      const sourceReads: string[] = [];
      const parseTotals: number[] = [];
      const result = refreshWikiIndex({
        scaffoldRoot: root,
        changed: [target],
        readFile: (absolutePath) => {
          sourceReads.push(absolutePath);
          return readFileSync(absolutePath, "utf-8");
        },
        maintenance: {
          reportProgress(progress) {
            if (progress.phase === "parse" && progress.total !== undefined) parseTotals.push(progress.total);
          },
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reparsed).toEqual([target]);
      expect(result.removed).toEqual([]);
      expect(result.unchanged).toEqual([]);
      expect(new Set(sourceReads)).toEqual(new Set([targetAbsolute]));
      expect(sourceReads.length).toBeGreaterThan(0);
      expect(parseTotals.length).toBeGreaterThan(0);
      expect(parseTotals.every((total) => total === 1)).toBe(true);
    },
    SCALE_TIMEOUT,
  );
});
