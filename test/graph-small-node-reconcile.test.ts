import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HI, LO, MIN_TOKENS, MOVED_MARGIN, W_BODY, W_NBR } from "../src/graph/config.js";
import { FingerprintStore } from "../src/graph/fingerprint-store.js";
import { MinHashReconciler, minhashJaccard, neighborOverlap } from "../src/graph/reconcile-engine.js";
import type { Fingerprint, Resolution } from "../src/graph/reconcile.js";

// Rename reconciliation for nodes below MIN_TOKENS (#229). Their body sketch
// cannot tell one small wrapper from another, so callers and callees decide,
// and a wrong MOVED, which rebinds silently, is the error that must not happen.

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../src/graph/schema.sql", import.meta.url), "utf8"));
  return db;
}

function insertNode(db: DatabaseSync, id: string, bodyHash = `hash-${id}`): void {
  db.prepare(
    `INSERT INTO nodes (id, kind, name, qualified_name, identity_key, file_path, language,
      start_line, end_line, start_column, end_column, body_hash, updated_at)
     VALUES (?, 'function', ?, ?, ?, 'src/a.ts', 'typescript', 1, 2, 0, 1, ?, 1)`,
  ).run(id, id, id, id, bodyHash);
}

function calls(db: DatabaseSync, source: string, target: string): void {
  db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, 'calls')").run(source, target);
}

/** `matches` of 64 minhash slots shared with the full sketch; `shape` offsets the rest. */
function sketch(matches: number, neighbors: string[], tokenCount: number, shape = 10_000): Fingerprint {
  return {
    minhash: Array.from({ length: 64 }, (_, index) => index < matches ? index : shape + index),
    neighbors: [...neighbors].sort(),
    tokenCount,
  };
}

const A = "function:caller-a";
const B = "function:caller-b";
const C = "function:caller-c";
const X = "function:callee-x";
const ELSEWHERE = "function:elsewhere";
const MISSING = "function:renamed-away";

/**
 * A graph holding the callers A, B, C, the callee X and ELSEWHERE, plus `nodes`, each
 * wired to its fingerprint's neighbors so edges and fingerprints agree.
 */
function graph(nodes: Array<{ id: string; fingerprint: Fingerprint; bodyHash?: string }>): {
  db: DatabaseSync;
  reconciler: MinHashReconciler;
} {
  const db = database();
  for (const id of [A, B, C, X, ELSEWHERE]) insertNode(db, id);
  const store = new FingerprintStore(db);
  for (const node of nodes) {
    insertNode(db, node.id, node.bodyHash);
    for (const neighbor of node.fingerprint.neighbors) {
      if (neighbor === X || neighbor === ELSEWHERE) calls(db, node.id, neighbor);
      else calls(db, neighbor, node.id);
    }
    store.upsert(node.id, node.fingerprint);
  }
  return { db, reconciler: new MinHashReconciler(store) };
}

describe("small-node reconciliation by callers and callees (#229)", () => {
  const baseline = sketch(64, [A, B, X], 15);

  it("finds a renamed small function through its unchanged callers and callee", () => {
    const { db, reconciler } = graph([{ id: "function:renamed", fingerprint: sketch(64, [A, B, X], 15) }]);
    expect(reconciler.reconcile(MISSING, baseline)).toEqual({ kind: "MOVED", nodeId: "function:renamed" });
    db.close();
  });

  it("returns AMBIGUOUS for two same-shaped small wrappers sharing the callers", () => {
    const { db, reconciler } = graph([
      { id: "function:wrapper-one", fingerprint: sketch(64, [A, B, X], 15) },
      { id: "function:wrapper-two", fingerprint: sketch(64, [A, B, X], 15) },
    ]);
    expect(reconciler.reconcile(MISSING, baseline))
      .toEqual({ kind: "AMBIGUOUS", candidate: "function:wrapper-one" });
    db.close();
  });

  it("does not rebind to an existing replacement that has a caller of its own", () => {
    // The small function was deleted and A and B now call `replacement`, which
    // already existed and was already called by C.
    const { db, reconciler } = graph([{ id: "function:replacement", fingerprint: sketch(64, [A, B, C, X], 15) }]);
    expect(reconciler.reconcile(MISSING, baseline))
      .toEqual({ kind: "AMBIGUOUS", candidate: "function:replacement" });
    db.close();
  });

  it("names a rename whose committed neighbors went stale, without rebinding it", () => {
    // Grounded when A and B called it; C has called it since. From the
    // committed baseline this is the replacement case above, so AMBIGUOUS.
    const { db, reconciler } = graph([{ id: "function:renamed", fingerprint: sketch(64, [A, C, X], 15) }]);
    expect(reconciler.reconcile(MISSING, baseline)).toEqual({ kind: "AMBIGUOUS", candidate: "function:renamed" });
    db.close();
  });

  it("stays GONE when the only function sharing the callers has a different body", () => {
    const { db, reconciler } = graph([{ id: "function:other", fingerprint: sketch(10, [A, B, C, X], 40) }]);
    expect(reconciler.reconcile(MISSING, baseline)).toEqual({ kind: "GONE" });
    db.close();
  });

  it("does not rebind to an existing replacement with a different body", () => {
    const { db, reconciler } = graph([{ id: "function:replacement", fingerprint: sketch(10, [A, B, X], 40) }]);
    expect(reconciler.reconcile(MISSING, baseline))
      .toEqual({ kind: "AMBIGUOUS", candidate: "function:replacement" });
    db.close();
  });

  it("reads a strong neighbor match with a changed token count as AMBIGUOUS", () => {
    const { db, reconciler } = graph([{ id: "function:renamed", fingerprint: sketch(64, [A, B, X], 25) }]);
    expect(reconciler.reconcile(MISSING, baseline)).toEqual({ kind: "AMBIGUOUS", candidate: "function:renamed" });
    db.close();
  });

  it("never matches a candidate of another kind", () => {
    const { db, reconciler } = graph([{ id: "method:renamed", fingerprint: sketch(64, [A, B, X], 15) }]);
    expect(reconciler.reconcile(MISSING, baseline)).toEqual({ kind: "GONE" });
    db.close();
  });

  it("stays GONE for a baseline with no neighbors, as before", () => {
    const { db, reconciler } = graph([{ id: "function:same-shape", fingerprint: sketch(64, [], 15) }]);
    expect(reconciler.reconcile(MISSING, sketch(64, [], 15))).toEqual({ kind: "GONE" });
    db.close();
  });

  it("never returns MOVED for a baseline with a single neighbor", () => {
    const { db, reconciler } = graph([{ id: "function:renamed", fingerprint: sketch(64, [A], 15) }]);
    expect(reconciler.reconcile(MISSING, sketch(64, [A], 15))).toEqual({ kind: "GONE" });
    db.close();
  });

  it("lets the committed body hash name an identical-text candidate, but only as AMBIGUOUS without neighbors", () => {
    const { db, reconciler } = graph([
      { id: "function:same-text", fingerprint: sketch(64, [], 15), bodyHash: "committed" },
      { id: "function:same-shape", fingerprint: sketch(64, [], 15), bodyHash: "other" },
    ]);
    expect(reconciler.reconcile(MISSING, sketch(64, [], 15), "committed"))
      .toEqual({ kind: "AMBIGUOUS", candidate: "function:same-text" });
    expect(reconciler.reconcile(MISSING, sketch(64, [], 15), "unknown")).toEqual({ kind: "GONE" });
    db.close();
  });

  it("breaks a small-node tie with the committed body hash", () => {
    const { db, reconciler } = graph([
      { id: "function:wrapper-one", fingerprint: sketch(64, [A, B, X], 15), bodyHash: "one" },
      { id: "function:wrapper-two", fingerprint: sketch(64, [A, B, X], 15), bodyHash: "two" },
    ]);
    expect(reconciler.reconcile(MISSING, baseline, "two")).toEqual({ kind: "MOVED", nodeId: "function:wrapper-two" });
    db.close();
  });
});

describe("committed body hash as a tie-breaker for normal-sized nodes", () => {
  const normal = sketch(64, [A], 40);

  it("rebinds to the one tied candidate whose text is identical", () => {
    const { db, reconciler } = graph([
      { id: "function:copy-a", fingerprint: normal, bodyHash: "other" },
      { id: "function:copy-b", fingerprint: normal, bodyHash: "committed" },
    ]);
    expect(reconciler.reconcile(MISSING, normal, "committed")).toEqual({ kind: "MOVED", nodeId: "function:copy-b" });
    expect(reconciler.reconcile(MISSING, normal)).toEqual({ kind: "AMBIGUOUS", candidate: "function:copy-a" });
    db.close();
  });

  it("stays AMBIGUOUS when several tied candidates have the identical text", () => {
    const { db, reconciler } = graph([
      { id: "function:copy-a", fingerprint: normal, bodyHash: "committed" },
      { id: "function:copy-b", fingerprint: normal, bodyHash: "committed" },
    ]);
    expect(reconciler.reconcile(MISSING, normal, "committed"))
      .toEqual({ kind: "AMBIGUOUS", candidate: "function:copy-a" });
    db.close();
  });
});

/** The reconciler as it was before #229, for normal-sized baselines: the oracle. */
function previousVerdict(store: FingerprintStore, baseline: Fingerprint): Resolution {
  if (baseline.tokenCount < MIN_TOKENS) return { kind: "GONE" };
  const candidates = store.lookup(baseline);
  if (candidates.length === 0) return { kind: "GONE" };
  const [best, runnerUp] = candidates
    .map((candidate) => ({
      ...candidate,
      score: W_BODY * minhashJaccard(baseline.minhash, candidate.fingerprint.minhash)
        + W_NBR * neighborOverlap(baseline.neighbors, candidate.fingerprint.neighbors),
    }))
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
  if (best.score >= HI) {
    if (runnerUp && best.score - runnerUp.score < MOVED_MARGIN) return { kind: "AMBIGUOUS", candidate: best.nodeId };
    return { kind: "MOVED", nodeId: best.nodeId };
  }
  if (best.score < LO) return { kind: "GONE" };
  return { kind: "AMBIGUOUS", candidate: best.nodeId };
}

describe("the existing reconciler corpus", () => {
  it("returns exactly the previous verdicts for every normal-sized baseline", () => {
    // Every shape the existing reconciler tests use, crossed with neighbor
    // sets, over a graph whose edges would feed the small-node path.
    const matches = [0, 2, 20, 30, 40, 44, 48, 52, 56, 60, 62, 64];
    const neighborSets = [[], [A], [A, B], [A, B, X], [A, B, C, X], [ELSEWHERE]];
    const nodes = matches.flatMap((match, index) => neighborSets.map((neighbors, set) => ({
      id: `function:candidate-${index}-${set}`,
      fingerprint: sketch(match, neighbors, 40),
    })));
    const { db, reconciler } = graph(nodes);
    const store = new FingerprintStore(db);
    let compared = 0;
    for (const match of matches) {
      for (const neighbors of neighborSets) {
        for (const tokenCount of [MIN_TOKENS, 40, 200]) {
          for (const shape of [10_000, 20_000]) {
            const probe = sketch(match, neighbors, tokenCount, shape);
            expect(reconciler.reconcile(MISSING, probe)).toEqual(previousVerdict(store, probe));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(matches.length * neighborSets.length * 3 * 2);
    db.close();
  });
});
