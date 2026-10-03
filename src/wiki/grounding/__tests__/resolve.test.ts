/**
 * Every row of the resolution table, against a graph that is a value.
 *
 * The graph here is a stub because three of the rows are reconciliation
 * outcomes — MOVED, AMBIGUOUS, GONE — and provoking those in a real repository
 * means arranging a symbol that the fingerprint matcher will score into a
 * particular band. That is a test of the matcher, which already has its own.
 * What needs testing here is the decision made *from* the outcome.
 *
 * The integration test (`integration.test.ts`) does the opposite: a real
 * temporary graph, real edits, and no stubs anywhere.
 */

import { describe, expect, it } from "vitest";
import {
  resolveEntityGroundings,
  resolveGrounding,
} from "../resolve.js";
import type { GroundedNode, GroundingGraph } from "../adapter.js";
import { serializeFingerprint } from "../../../graph/fingerprint.js";
import type { WikiGrounding } from "../../model/grounding.js";

const NODE = "function:1a2b3c4d5e6f7a8b";
const MOVED_NODE = "function:9c8d7e6f5a4b3c2d";
const FINGERPRINT = "mh:64:0a0b0c0d";
const OTHER_FINGERPRINT = "mh:64:1a1b1c1d";

function node(id: string, bodyHash: string | null): GroundedNode {
  return { id, bodyHash, filePath: "src/auth.ts", startLine: 1, endLine: 9 };
}

interface StubOptions {
  nodes?: Record<string, GroundedNode>;
  fingerprints?: Record<string, string>;
  reconcile?: GroundingGraph["reconcile"];
}

function stubGraph(options: StubOptions = {}): GroundingGraph {
  return {
    getNode: (id) => options.nodes?.[id] ?? null,
    getFingerprint: (id) => options.fingerprints?.[id] ?? null,
    reconcile: options.reconcile ?? (() => ({ kind: "GONE" })),
    // Deliberately explosive. Nothing in resolution may consult the cached
    // baseline to reach a verdict, and a stub that quietly returned null would
    // let a regression through as a behaviour change rather than a failure.
    getBaselineSource: () => {
      throw new Error("resolution consulted the cached baseline");
    },
  };
}

const GROUNDED: WikiGrounding = { node: NODE, fingerprint: FINGERPRINT, bodyHash: "body-1" };

describe("the resolution table", () => {
  it("node found and the committed body hash matches: fresh", () => {
    const resolution = resolveGrounding(
      GROUNDED,
      stubGraph({ nodes: { [NODE]: node(NODE, "body-1") } }),
    );
    expect(resolution).toEqual({
      state: "fresh",
      health: "fresh",
      node: NODE,
      resolvedNode: NODE,
      rebound: false,
      bodyHash: "body-1",
    });
  });

  it("node found and the committed body hash diverges: stale/changed", () => {
    const resolution = resolveGrounding(
      GROUNDED,
      stubGraph({ nodes: { [NODE]: node(NODE, "body-2") } }),
    );
    expect(resolution).toMatchObject({
      state: "stale",
      health: "changed",
      node: NODE,
      resolvedNode: NODE,
      baselineBodyHash: "body-1",
      currentBodyHash: "body-2",
    });
  });

  it("Tier-1 miss resolving MOVED rebinds, and the entity id is not involved", () => {
    const resolution = resolveGrounding(GROUNDED, stubGraph({
      nodes: { [MOVED_NODE]: node(MOVED_NODE, "body-1") },
      fingerprints: { [MOVED_NODE]: FINGERPRINT },
      reconcile: () => ({ kind: "MOVED", nodeId: MOVED_NODE }),
    }));
    expect(resolution).toEqual({
      state: "fresh",
      health: "fresh",
      // The declared node is what Markdown still says; `resolvedNode` is where
      // it went. Nothing here touches the entity's own id (§5.6, §8.7).
      node: NODE,
      resolvedNode: MOVED_NODE,
      rebound: true,
      bodyHash: "body-1",
    });
  });

  it("calls a rebound node with a byte-identical body fresh, whatever its fingerprint", () => {
    // The graph answers the declared id with the node a compatibility alias
    // recorded for it after ids were re-minted (#240). Its neighbours were
    // renumbered, so its fingerprint differs; its body did not.
    const aliased = stubGraph({
      nodes: { [NODE]: node(MOVED_NODE, "body-1") },
      fingerprints: { [MOVED_NODE]: "mh:64:ffffffff" },
    });
    expect(resolveGrounding(GROUNDED, aliased)).toEqual({
      state: "fresh",
      health: "fresh",
      node: NODE,
      resolvedNode: MOVED_NODE,
      rebound: true,
      bodyHash: "body-1",
    });

    // A body that differs is still judged by structure.
    const edited = stubGraph({
      nodes: { [NODE]: node(MOVED_NODE, "body-2") },
      fingerprints: { [MOVED_NODE]: "mh:64:ffffffff" },
    });
    expect(resolveGrounding(GROUNDED, edited)).toMatchObject({ state: "stale", health: "changed", resolvedNode: MOVED_NODE });
  });

  it("judges a grounding with no body hash by its code, not by who calls it", () => {
    const code = { minhash: Array.from({ length: 64 }, (_, index) => index * 7919), tokenCount: 40 };
    const committed = serializeFingerprint({ ...code, neighbors: [`function:${"a".repeat(32)}`] });
    const legacyGrounding: WikiGrounding = { node: NODE, fingerprint: committed };
    // Neighbours renumbered (#240) and a new caller: the same code.
    const renumbered = serializeFingerprint({ ...code, neighbors: [`function:${"b".repeat(32)}`, `method:${"c".repeat(32)}`] });
    expect(resolveGrounding(legacyGrounding, stubGraph({
      nodes: { [NODE]: node(NODE, "body-9") },
      fingerprints: { [NODE]: renumbered },
    }))).toMatchObject({ state: "fresh", health: "fresh" });
    // A rewritten body changes the sketch, and that is still drift.
    const rewritten = serializeFingerprint({ ...code, minhash: code.minhash.map((value) => value + 1), neighbors: [] });
    expect(resolveGrounding(legacyGrounding, stubGraph({
      nodes: { [NODE]: node(NODE, "body-9") },
      fingerprints: { [NODE]: rewritten },
    }))).toMatchObject({ state: "stale", health: "changed" });
  });

  it("compares a rebind by fingerprint, because a rename always moves the body hash", () => {
    // Measured against a real graph: renaming a symbol changes its body hash,
    // since the name is part of the body. If a rebind were compared by body
    // hash, `fresh` with `rebound: true` would be unreachable and every rename
    // would read as drift — the brief's MOVED row inverted.
    const resolution = resolveGrounding(GROUNDED, stubGraph({
      nodes: { [MOVED_NODE]: node(MOVED_NODE, "a-different-body-hash") },
      fingerprints: { [MOVED_NODE]: FINGERPRINT },
      reconcile: () => ({ kind: "MOVED", nodeId: MOVED_NODE }),
    }));
    expect(resolution).toMatchObject({ state: "fresh", health: "fresh", rebound: true, resolvedNode: MOVED_NODE });
  });

  it("Tier-1 miss resolving MOVED to a rewritten symbol is stale, not fresh", () => {
    // The other half. Reconciliation matches on *similarity*, so a symbol can
    // move and be rewritten in one commit; reporting that as fresh would let
    // drift through the rename door.
    const resolution = resolveGrounding(GROUNDED, stubGraph({
      nodes: { [MOVED_NODE]: node(MOVED_NODE, "body-9") },
      fingerprints: { [MOVED_NODE]: OTHER_FINGERPRINT },
      reconcile: () => ({ kind: "MOVED", nodeId: MOVED_NODE }),
    }));
    expect(resolution).toMatchObject({
      state: "stale",
      health: "changed",
      node: NODE,
      resolvedNode: MOVED_NODE,
      currentBodyHash: "body-9",
    });
  });

  it("Tier-1 miss resolving AMBIGUOUS: unresolved/ambiguous, with the candidate", () => {
    const resolution = resolveGrounding(GROUNDED, stubGraph({
      reconcile: () => ({ kind: "AMBIGUOUS", candidate: MOVED_NODE }),
    }));
    expect(resolution).toMatchObject({
      state: "unresolved",
      health: "ambiguous",
      node: NODE,
      candidates: [MOVED_NODE],
    });
  });

  it("Tier-1 miss resolving GONE: missing/missing", () => {
    const resolution = resolveGrounding(GROUNDED, stubGraph({ reconcile: () => ({ kind: "GONE" }) }));
    expect(resolution).toMatchObject({ state: "missing", health: "missing", node: NODE });
  });

  it("no graph: unresolved/unverified, never a fabricated fresh", () => {
    const resolution = resolveGrounding(GROUNDED, null);
    expect(resolution).toMatchObject({ state: "unresolved", health: "unverified", node: NODE });
    // §8.7: "a missing graph degrades to `unresolved`, not a fabricated `fresh`
    // result". Stated as an assertion because it is the tempting shortcut.
    expect(resolution.health).not.toBe("fresh");
  });

  it("an undecodable committed fingerprint: unverified, not missing", () => {
    // "We could not look" and "we looked and it is gone" are different facts,
    // and reporting the second for the first would send a reviewer hunting for
    // a deletion that never happened.
    const resolution = resolveGrounding(
      { node: NODE, fingerprint: "not-a-fingerprint" },
      stubGraph({ reconcile: () => null }),
    );
    expect(resolution).toMatchObject({ state: "unresolved", health: "unverified" });
  });

  it("a rebind naming a node the graph does not hold: unverified", () => {
    const resolution = resolveGrounding(GROUNDED, stubGraph({
      reconcile: () => ({ kind: "MOVED", nodeId: MOVED_NODE }),
      // ...and no `nodes` entry for it.
    }));
    expect(resolution).toMatchObject({ state: "unresolved", health: "unverified" });
  });

  it("an entity with no groundings at all: ungrounded, health unverified", () => {
    const resolved = resolveEntityGroundings([], stubGraph());
    expect(resolved.groundings).toEqual([]);
    // Absence of evidence is not freshness. Defaulting the other way would make
    // an entirely ungrounded wiki look fully verified.
    expect(resolved.health).toBe("unverified");
  });
});

describe("what is compared, and what it can see", () => {
  it("prefers the body hash committed in Markdown", () => {
    // The measured fact this whole design turns on: the extractor represents
    // literals and identifiers by grammar kind, so editing a constant leaves
    // the fingerprint byte-identical while the body hash moves. A
    // fingerprint-only check calls this `fresh` forever.
    const graph = stubGraph({
      nodes: { [NODE]: node(NODE, "body-after-constant-change") },
      fingerprints: { [NODE]: FINGERPRINT },
    });

    expect(resolveGrounding(GROUNDED, graph)).toMatchObject({ state: "stale", health: "changed" });

    // The same edit, seen by a grounding that committed no body hash: the
    // fingerprint still matches, so it reads fresh. This is the blindness, and
    // it is asserted rather than described so that removing the body-hash
    // comparison cannot look like an improvement.
    expect(resolveGrounding({ node: NODE, fingerprint: FINGERPRINT }, graph))
      .toMatchObject({ state: "fresh", health: "fresh" });
  });

  it("falls back to the fingerprint when Markdown committed no body hash", () => {
    const graph = stubGraph({
      nodes: { [NODE]: node(NODE, "body-2") },
      fingerprints: { [NODE]: OTHER_FINGERPRINT },
    });
    expect(resolveGrounding({ node: NODE, fingerprint: FINGERPRINT }, graph))
      .toMatchObject({ state: "stale", health: "changed", currentBodyHash: "body-2" });
  });

  it("treats an empty committed body hash as absent rather than as a value", () => {
    // A node with no body (an interface, a type alias) has no body hash. An
    // empty string committed for it must not be compared as if it meant
    // something, or every such grounding reads stale forever.
    const graph = stubGraph({
      nodes: { [NODE]: node(NODE, null) },
      fingerprints: { [NODE]: FINGERPRINT },
    });
    expect(resolveGrounding({ node: NODE, fingerprint: FINGERPRINT, bodyHash: "" }, graph))
      .toMatchObject({ state: "fresh", health: "fresh" });
  });

  it("cannot compare when the graph has no fingerprint for the node either", () => {
    const graph = stubGraph({ nodes: { [NODE]: node(NODE, null) } });
    expect(resolveGrounding({ node: NODE, fingerprint: FINGERPRINT }, graph))
      .toMatchObject({ state: "unresolved", health: "unverified" });
  });

  it("never consults the cached baseline to reach a verdict", () => {
    // Enforced by the stub throwing. If a future change resolves by comparing
    // against `graph.db`'s cached body_hash — the failure the whole phase is
    // shaped around — every test in this file fails loudly rather than one
    // subtly changing its answer.
    const graph = stubGraph({ nodes: { [NODE]: node(NODE, "body-1") } });
    expect(() => resolveGrounding(GROUNDED, graph)).not.toThrow();
    expect(() => graph.getBaselineSource({ kind: "entity", id: "mx_x" }, NODE)).toThrow();
  });
});

describe("aggregating an entity's health", () => {
  it("takes the worst, by the model's precedence and not the ranking order", () => {
    const graph = stubGraph({
      nodes: { [NODE]: node(NODE, "body-2") },
      reconcile: () => ({ kind: "AMBIGUOUS", candidate: MOVED_NODE }),
    });
    // `changed` from the first, `ambiguous` from the second. The model calls
    // ambiguous worse; the query layer's HEALTH_RANK penalizes changed more.
    // They answer different questions and aggregation uses the model's.
    const resolved = resolveEntityGroundings(
      [GROUNDED, { node: "function:deadbeefdeadbeef", fingerprint: FINGERPRINT, bodyHash: "x" }],
      graph,
    );
    expect(resolved.groundings.map((entry) => entry.health)).toEqual(["changed", "ambiguous"]);
    expect(resolved.health).toBe("ambiguous");
  });

  it("keeps one resolution per declared grounding, in declaration order", () => {
    const resolved = resolveEntityGroundings(
      [GROUNDED, { node: MOVED_NODE, fingerprint: FINGERPRINT, bodyHash: "body-1" }],
      stubGraph({ nodes: { [NODE]: node(NODE, "body-1"), [MOVED_NODE]: node(MOVED_NODE, "body-1") } }),
    );
    expect(resolved.groundings.map((entry) => entry.state)).toEqual(["fresh", "fresh"]);
    expect(resolved.health).toBe("fresh");
  });
});
