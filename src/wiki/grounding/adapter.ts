/**
 * The one seam between the wiki and the code graph.
 *
 * Everything the wiki needs to know about code goes through this file. Two
 * interfaces live here because the wiki asks the graph two unrelated kinds of
 * question, and one widened interface would let either half reach for the
 * other's powers:
 *
 * - {@link GroundingGraph} — is this node still there, what does it look like
 *   now, and if it is gone, did it move. Resolution's surface.
 * - {@link SynthesisGraph} — what code is there at all. Enumeration, which
 *   resolution must never be able to do.
 *
 * One file, one import of `src/graph/`, one lint rule pinning it.
 *
 * **Why a single seam rather than importing the engine where it is needed.**
 * P2b learned this the expensive way with AST offsets: `createPositionMap` is
 * the only place a remark position becomes a file offset, because the second
 * place someone writes that conversion is the place the BOM correction is
 * forgotten. The same shape of hazard is here. Resolution has a rule — the
 * canonical reference is in Markdown, the graph's cached baseline is never the
 * oracle — and that rule is enforceable only while there is one door. A second
 * module reaching for `FingerprintStore.getGroundedSource` and comparing its
 * `bodyHash` would be the exact bug, written by someone who had read neither
 * this comment nor the spec.
 *
 * The interface is also what makes {@link resolveGrounding} testable without a
 * real graph, which matters because every row of the resolution table needs a
 * test and three of those rows are reconciliation outcomes that are awkward to
 * provoke in a real repository.
 */

import { serializeFingerprint, deserializeFingerprint } from "../../graph/fingerprint.js";
import { FingerprintStore } from "../../graph/fingerprint-store.js";
import { GraphStore } from "../../graph/db/store.js";
import type { GraphEngine } from "../../graph/engine.js";
import type { Fingerprint, Reconciler, Resolution } from "../../graph/reconcile.js";
import type { SqliteDatabase } from "../../graph/db/sqlite.js";
import type { GroundingBaseline, GroundingSubject } from "../../graph/grounding.js";
import { asGraphDerived, type GraphDerivedGrounding, type WikiGrounding } from "../model/grounding.js";

/** What resolution knows about one code node, as the wiki sees it. */
export interface GroundedNode {
  id: string;
  /** sha256 of the node's body in *this* checkout, right now. */
  bodyHash: string | null;
  /** Repository-relative path, for display when a reviewer asks where. */
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * The graph, reduced to what grounding resolution actually asks of it.
 *
 * Deliberately small and deliberately read-only. Nothing here can write to the
 * graph, so no resolution can turn into a re-grounding by accident — which is
 * what would make drift disappear behind a helpful-looking cache update.
 */
export interface GroundingGraph {
  /** The node under this id, or null when the graph has no such node. */
  getNode(nodeId: string): GroundedNode | null;
  /** The node's serialized fingerprint in this checkout, or null. */
  getFingerprint(nodeId: string): string | null;
  /**
   * Tier-1 miss: try to find where the symbol went, using the fingerprint the
   * entity committed to Markdown.
   *
   * Returns null when the committed fingerprint cannot be decoded, which is a
   * different situation from "we looked and found nothing" and resolves
   * differently.
   */
  reconcile(nodeId: string, committedFingerprint: string, bodyHash?: string): Resolution | null;
  /**
   * The cached baseline for one (subject, node), **for rendering an old-vs-new
   * diff only**.
   *
   * Never consult this to decide whether something drifted. It is re-captured
   * by an ordinary graph rebuild, so a current-against-baseline comparison is a
   * current-against-current comparison and reports `fresh` for code that
   * changed — at exactly the moment the user did the most ordinary thing
   * available to them.
   */
  getBaselineSource(subject: GroundingSubject, nodeId: string): GroundingBaseline | null;
}

/** Build the graph-backed implementation. The only place `src/graph/` is bound in. */
export function createGroundingGraph(
  engine: Pick<GraphEngine, "getNode">,
  /** May take the committed body hash as a tie-breaker, as the graph's reconciler does (#229). */
  reconciler: Reconciler & { reconcile(nodeId: string, baseline: Fingerprint, bodyHash?: string): Resolution },
  db: SqliteDatabase,
): GroundingGraph {
  const store = new FingerprintStore(db);
  return {
    getNode(nodeId) {
      const node = engine.getNode(nodeId);
      return node === null ? null : {
        id: node.id,
        bodyHash: node.bodyHash ?? null,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
      };
    },
    getFingerprint(nodeId) {
      const fingerprint = store.get(nodeId);
      return fingerprint === null ? null : serializeFingerprint(fingerprint);
    },
    reconcile(nodeId, committedFingerprint, bodyHash) {
      const decoded = deserializeFingerprint(committedFingerprint);
      return decoded === null ? null : reconciler.reconcile(nodeId, decoded, bodyHash);
    },
    getBaselineSource(subject, nodeId) {
      return store.getBaseline(subject, nodeId);
    },
  };
}

/**
 * Mint a grounding from live graph output — the only way one is ever created.
 *
 * §12.4: an agent may not invent a node id or a fingerprint. The brand on the
 * return type is the type-level half of that (P0/P1 made a parsed grounding
 * un-assignable to it); this function is the runtime half, and it takes the
 * node id rather than a caller-supplied pair so there is nothing to launder.
 * A node the graph does not have yields null, not a plausible-looking record.
 *
 * `bodyHash` is captured here, always. It is the value drift is later measured
 * against, and a grounding written without it can only ever be checked by the
 * coarser structural comparator.
 */
export function deriveGrounding(
  graph: GroundingGraph,
  nodeId: string,
  extra: Omit<WikiGrounding, "node" | "fingerprint" | "bodyHash"> = {},
): GraphDerivedGrounding | null {
  const node = graph.getNode(nodeId);
  if (node === null) return null;
  const fingerprint = graph.getFingerprint(nodeId);
  if (fingerprint === null) return null;

  const grounding: WikiGrounding = {
    ...extra,
    node: node.id,
    fingerprint,
    ...(node.bodyHash === null ? {} : { bodyHash: node.bodyHash }),
    ...(extra.file === undefined ? { file: node.filePath } : {}),
  };
  return asGraphDerived(grounding, { derivedFromLiveGraph: true });
}

// ----------------------------------------------------------------------------
// The synthesis read surface
// ----------------------------------------------------------------------------

/**
 * What synthesis needs to know about code — the second surface behind this one
 * door.
 *
 * It is here rather than in `src/wiki/synthesis/` for the reason the module
 * comment gives: there is one place that binds `src/graph/`, and a second
 * module reaching for the engine would be the failure the lint rule exists to
 * catch. `GroundingGraph` answers "is this node still there"; this answers
 * "what code is there at all", which is a different question over the same
 * store and deserves its own interface rather than a widened one — nothing in
 * resolution should be able to enumerate a repository.
 *
 * Every method is read-only and every one is bounded by the caller, not here:
 * clustering is inherently whole-repository, so the honest shape is to return
 * what was asked for and let the caller say how much it asked for.
 */
export interface SynthesisGraph {
  /** Every indexed file, deduplicated, in path order. */
  listFiles(): Array<{ path: string }>;
  /** The declarations in one file. Empty for a path the graph does not know. */
  nodesInFile(filePath: string): Array<{ id: string; kind: string }>;
  /** Structural detail for one node, or null when the graph has no such node. */
  describeNode(nodeId: string): SynthesisNode | null;
  /** Ids with a `calls` edge into this node. */
  callersOf(nodeId: string): string[];
  /** Ids this node has a `calls` edge to. */
  calleesOf(nodeId: string): string[];
  /** Outgoing structural edges of any kind. */
  outgoingEdges(nodeId: string): Array<{ source: string; target: string; kind: string }>;
}

/** One declaration, as synthesis sees it. */
export interface SynthesisNode {
  id: string;
  kind: string;
  name: string;
  filePath: string;
  qualifiedName?: string;
  signature?: string;
  docstring?: string;
  startLine: number;
  endLine: number;
  /** Drives the importance ranking. mex's extractor produces both. */
  isExported?: boolean;
  visibility?: "public" | "private" | "protected" | "internal";
}

/**
 * Build the graph-backed synthesis reader.
 *
 * **Why the node table is read once.** `nodesInFile` is asked for every file in
 * the repository, so a per-file query would be one statement per file; one read
 * bucketed by path is a single statement instead. That is also what makes the
 * cost visible: the whole node set is materialized here, once, where a reader
 * can see it, rather than accumulating invisibly across a thousand calls.
 */
export function createSynthesisGraph(
  engine: Pick<GraphEngine, "getOutgoing" | "getIncoming">,
  db: SqliteDatabase,
): SynthesisGraph {
  const store = new GraphStore(db);
  let byFile: Map<string, Array<{ id: string; kind: string }>> | null = null;
  let byId: Map<string, SynthesisNode> | null = null;

  const load = (): void => {
    if (byFile !== null && byId !== null) return;
    byFile = new Map();
    byId = new Map();
    for (const node of store.getAllNodes()) {
      const bucket = byFile.get(node.filePath) ?? [];
      bucket.push({ id: node.id, kind: node.kind });
      byFile.set(node.filePath, bucket);
      byId.set(node.id, {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        ...(node.qualifiedName === undefined ? {} : { qualifiedName: node.qualifiedName }),
        ...(node.signature === undefined ? {} : { signature: node.signature }),
        ...(node.docstring === undefined ? {} : { docstring: node.docstring }),
        ...(node.isExported === undefined ? {} : { isExported: node.isExported }),
        ...(node.visibility === undefined ? {} : { visibility: node.visibility }),
      });
    }
  };

  return {
    listFiles() {
      load();
      return [...byFile!.keys()].sort().map((path) => ({ path }));
    },
    nodesInFile(filePath) {
      load();
      return byFile!.get(filePath) ?? [];
    },
    describeNode(nodeId) {
      load();
      return byId!.get(nodeId) ?? null;
    },
    callersOf(nodeId) {
      return engine.getIncoming(nodeId, ["calls"]).map((neighbor) => neighbor.edge.source);
    },
    calleesOf(nodeId) {
      return engine.getOutgoing(nodeId, ["calls"]).map((neighbor) => neighbor.edge.target);
    },
    outgoingEdges(nodeId) {
      return engine
        .getOutgoing(nodeId)
        .map((neighbor) => ({ source: neighbor.edge.source, target: neighbor.edge.target, kind: neighbor.edge.kind }));
    },
  };
}
