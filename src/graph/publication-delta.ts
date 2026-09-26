// ============================================================================
// mex code-graph — incremental publication (issue #209)
// ============================================================================
//
// A full publication clears every derived row and inserts the whole corpus
// again. This module publishes the same graph as a delta instead.
//
// Every derived row is owned by exactly one file:
//   * a node by its own file;
//   * an edge, and an unresolved reference, by the file of the node it leaves;
//   * an import binding by its file;
//   * a fingerprint (and its LSH buckets) by its node's file;
//   * source chunks by their file, and they are a function of its content.
// One digest per file covers the exact row images that file owns, edge
// targets and fingerprint neighbours included. A publication rewrites only the
// files whose digest changed, and the result is the rows a full publication
// writes: an unchanged digest means the file's rows are unchanged, and any
// cross-file effect of a change (an edge or binding pointing at a node that
// disappeared, a caller added to a fingerprint's neighbourhood) changes the
// digest of the file that owns the affected row.
//
// Nodes of a rewritten file are updated in place and only nodes that
// disappeared are deleted, so the foreign-key cascades never remove a row owned
// by an unchanged file. The digests are trusted only for the snapshot they
// were written with; a publication by any other writer invalidates them.

import { createHash } from "node:crypto";
import {
  edgeKey,
  edgeRowImage,
  fileRecordImage,
  importBindingRowImage,
  nodeRowImage,
  unresolvedRefKey,
  unresolvedRefRowImage,
  type FileRecord,
  type GraphStore,
  type ImportBindingRecord,
  type UnresolvedRefRecord,
} from "./db/store.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { readFileFingerprints, writeFingerprintDelta, type StoredFingerprint } from "./fingerprint-store.js";
import type { Fingerprint } from "./reconcile.js";
import { GRAPH_SNAPSHOT_METADATA_KEY } from "./snapshot.js";
import type { GraphEdge, GraphNode } from "./types.js";

/**
 * project_metadata key: sha256 of the serialized snapshot that the row digests
 * and the extraction cache describe. Written in the transaction that
 * publishes that snapshot, so any other writer leaves it stale.
 */
export const INCREMENTAL_STATE_METADATA_KEY = "incremental_state_snapshot";

export interface PublicationFile {
  record: FileRecord;
  nodes: GraphNode[];
  edges: GraphEdge[];
  references: UnresolvedRefRecord[];
  imports: ImportBindingRecord[];
}

/** The derived rows one file owns, as a publication writes them. */
export interface FileRowGroup {
  path: string;
  /** The file's content hash; its source chunks are a function of it. */
  contentHash?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Stored references only (a resolved reference is an edge), in write order. */
  references: UnresolvedRefRecord[];
  /** In write order: a repeated binding key keeps its first row's columns. */
  imports: ImportBindingRecord[];
  fingerprints: Map<string, Fingerprint>;
  digest: string;
}

export interface FileRowGroups {
  groups: Map<string, FileRowGroup>;
  /** Distinct edge rows the publication stores. */
  edgeCount: number;
}

/**
 * Group every row a publication writes by its owning file and digest each
 * group. Returns a reason instead when ownership is not a partition, so the
 * caller publishes in full: a repeated unresolved-reference or binding key
 * across two files would make the stored row depend on file order.
 */
export function groupRowsByFile(
  files: readonly PublicationFile[],
  fingerprints: Iterable<{ nodeId: string; fingerprint: Fingerprint }>,
): FileRowGroups | { reason: string } {
  const groups = new Map<string, FileRowGroup>();
  const group = (path: string): FileRowGroup => {
    let existing = groups.get(path);
    if (!existing) {
      existing = {
        path, nodes: [], edges: [], references: [], imports: [], fingerprints: new Map(), digest: "",
      };
      groups.set(path, existing);
    }
    return existing;
  };
  const ownerByNode = new Map<string, string>();
  for (const file of files) {
    group(file.record.path).contentHash = file.record.contentHash;
    for (const node of file.nodes) {
      ownerByNode.set(node.id, node.filePath);
      group(node.filePath).nodes.push(node);
    }
  }
  const edgeKeys = new Set<string>();
  const referenceOwners = new Map<string, string>();
  const bindingOwners = new Map<string, string>();
  for (const file of files) {
    for (const edge of file.edges) {
      const owner = ownerByNode.get(edge.source);
      if (owner === undefined) return { reason: "an edge leaves a node outside the corpus" };
      group(owner).edges.push(edge);
      edgeKeys.add(edgeKey(edge));
    }
    for (const reference of file.references) {
      if (reference.status === "resolved") continue;
      const owner = ownerByNode.get(reference.fromNodeId);
      if (owner === undefined) return { reason: "a reference leaves a node outside the corpus" };
      const key = unresolvedRefKey(reference);
      if ((referenceOwners.get(key) ?? owner) !== owner) return { reason: "a reference key spans two files" };
      referenceOwners.set(key, owner);
      group(owner).references.push(reference);
    }
    for (const binding of file.imports) {
      const owner = binding.filePath;
      if ((bindingOwners.get(binding.bindingKey) ?? owner) !== owner) {
        return { reason: "an import binding key spans two files" };
      }
      bindingOwners.set(binding.bindingKey, owner);
      group(owner).imports.push(binding);
    }
  }
  // The last fingerprint for a node wins, as in a full publication.
  for (const { nodeId, fingerprint } of fingerprints) {
    const owner = ownerByNode.get(nodeId);
    if (owner === undefined) return { reason: "a fingerprint belongs to a node outside the corpus" };
    group(owner).fingerprints.set(nodeId, fingerprint);
  }
  for (const entry of groups.values()) entry.digest = digestRowGroup(entry);
  return { groups, edgeCount: edgeKeys.size };
}

function digestRowGroup(group: FileRowGroup): string {
  const hash = createHash("sha256");
  // One update per section: the same bytes as a line at a time, far fewer calls.
  const section = (name: string, lines: readonly string[]): void => {
    hash.update(lines.length === 0 ? `${name}\n` : `${name}\n${lines.join("\n")}\n`);
  };
  section("content", [group.contentHash ?? ""]);
  section("nodes", group.nodes.map(nodeRowImage).sort());
  section("edges", group.edges.map(edgeRowImage).sort());
  section("references", group.references.map(unresolvedRefRowImage));
  section("imports", group.imports.map(importBindingRowImage));
  section("fingerprints", [...group.fingerprints.entries()]
    .map(([nodeId, fingerprint]) => fingerprintImage(nodeId, fingerprint))
    .sort());
  return hash.digest("hex");
}

function fingerprintImage(nodeId: string, fingerprint: Fingerprint): string {
  return JSON.stringify([nodeId, fingerprint.minhash, fingerprint.neighbors, fingerprint.tokenCount]);
}

/** The marker a publication writes for the snapshot it publishes. */
export function incrementalStateMarker(serializedSnapshot: string): string {
  return createHash("sha256").update(serializedSnapshot).digest("hex");
}

/** Whether the stored row digests and extraction cache describe the stored graph. */
export function incrementalStateIsCurrent(store: GraphStore): boolean {
  const storedSnapshot = store.getMetadata(GRAPH_SNAPSHOT_METADATA_KEY);
  const marker = store.getMetadata(INCREMENTAL_STATE_METADATA_KEY);
  return storedSnapshot !== null && marker !== null && marker === incrementalStateMarker(storedSnapshot);
}

/** What an incremental publication rewrites, read before any row changes. */
export interface RowDelta {
  /** Files whose rows change, in publication order. */
  rewritten: FileRowGroup[];
  /** Files that owned rows and own none now. */
  removed: string[];
  /** Stored nodes of every rewritten or removed file. */
  previousNodes: Map<string, GraphNode[]>;
  /** Stored fingerprints of every rewritten or removed file. */
  previousFingerprints: Map<string, StoredFingerprint[]>;
  /** Stored nodes that the publication deletes. */
  vanished: GraphNode[];
}

/**
 * Plan a delta against the stored graph, or return why a full publication is
 * required. The digests must describe exactly the stored rows: they are
 * trusted only when the marker beside them names the stored snapshot.
 */
export function planRowDelta(
  store: GraphStore,
  db: SqliteDatabase,
  grouped: FileRowGroups,
): RowDelta | { reason: string } {
  if (!incrementalStateIsCurrent(store)) return { reason: "no row digests describe the stored graph" };
  const stored = store.getFileRowDigests();
  const rewritten = [...grouped.groups.values()].filter((group) => stored.get(group.path) !== group.digest);
  const removed = [...stored.keys()].filter((path) => !grouped.groups.has(path)).sort();
  const previousNodes = new Map<string, GraphNode[]>();
  const previousFingerprints = new Map<string, StoredFingerprint[]>();
  for (const path of [...rewritten.map((group) => group.path), ...removed]) {
    previousNodes.set(path, store.getNodesByFile(path));
    previousFingerprints.set(path, readFileFingerprints(db, path));
  }
  const freshIds = new Set<string>();
  for (const group of grouped.groups.values()) for (const node of group.nodes) freshIds.add(node.id);
  const vanished = [...previousNodes.values()].flat().filter((node) => !freshIds.has(node.id));
  return { rewritten, removed, previousNodes, previousFingerprints, vanished };
}

/** Above this many deleted nodes, index `import_bindings(target_id)` for the write. */
const BINDING_TARGET_INDEX_THRESHOLD = 1;

/**
 * Apply a planned delta inside the caller's publication transaction, which
 * MUST roll back if this throws. Aliases, the search index (maintained by the
 * node triggers), invariants and metadata stay with the caller.
 */
export function applyRowDelta(
  store: GraphStore,
  db: SqliteDatabase,
  delta: RowDelta,
  records: ReadonlyMap<string, FileRecord>,
  readSource: (path: string) => string,
): void {
  const touched = [...delta.rewritten.map((group) => group.path), ...delta.removed];

  // 1. Relations leaving the stored nodes of every touched file.
  for (const path of touched) store.deleteFileRelations(path);

  // 2. Nodes: write changed and new rows in place, so rows other files own
  //    that point at a surviving node are never cascaded away.
  for (const group of delta.rewritten) {
    const previous = new Map((delta.previousNodes.get(group.path) ?? [])
      .map((node) => [node.id, nodeRowImage(node)]));
    for (const node of group.nodes) {
      if (previous.get(node.id) !== nodeRowImage(node)) store.insertNode(node);
    }
  }

  // 3. Fingerprints, before any node is deleted: a removed fingerprint row is
  //    deleted directly rather than through the node cascade.
  const removedFingerprints: StoredFingerprint[] = [];
  const writtenFingerprints: Array<{ nodeId: string; fingerprint: Fingerprint; previous?: StoredFingerprint }> = [];
  const freshByPath = new Map(delta.rewritten.map((group) => [group.path, group.fingerprints]));
  for (const path of touched) {
    const fresh = freshByPath.get(path) ?? new Map<string, Fingerprint>();
    const previous = new Map((delta.previousFingerprints.get(path) ?? []).map((stored) => [stored.nodeId, stored]));
    for (const stored of previous.values()) if (!fresh.has(stored.nodeId)) removedFingerprints.push(stored);
    for (const [nodeId, fingerprint] of fresh) {
      const before = previous.get(nodeId);
      if (before && fingerprintImage(nodeId, before.fingerprint) === fingerprintImage(nodeId, fingerprint)) continue;
      writtenFingerprints.push({ nodeId, fingerprint, ...(before ? { previous: before } : {}) });
    }
  }
  writtenFingerprints.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  writeFingerprintDelta(db, removedFingerprints, writtenFingerprints);

  // 4. Nodes that disappeared. Their own relations and fingerprints are gone
  //    already; the cascade clears aliases and edges into them.
  const indexed = delta.vanished.length > BINDING_TARGET_INDEX_THRESHOLD;
  if (indexed) db.exec("CREATE INDEX mex_publication_binding_target ON import_bindings(target_id)");
  for (const node of delta.vanished) store.deleteNode(node.id);
  if (indexed) db.exec("DROP INDEX mex_publication_binding_target");

  // 5. Relations of every rewritten file, now that every endpoint exists.
  for (const group of delta.rewritten) {
    for (const edge of group.edges) store.insertEdge(edge);
    for (const reference of group.references) store.insertUnresolvedRef(reference);
    for (const binding of group.imports) store.insertImportBinding(binding);
  }

  // 6. File rows and source chunks.
  for (const record of records.values()) {
    const before = store.getFileRecord(record.path);
    if (!before || before.contentHash !== record.contentHash) {
      store.replaceSourceChunks(record.path, readSource(record.path), record.contentHash);
    }
    if (!before || fileRecordChanged(before, record)) store.upsertFile(record);
  }
  for (const before of store.getAllFileRecords()) {
    if (records.has(before.path)) continue;
    store.deleteSourceChunks(before.path);
    store.deleteFileRecord(before.path);
  }

  // 7. Digests.
  for (const group of delta.rewritten) store.setFileRowDigest(group.path, group.digest);
  for (const path of delta.removed) store.deleteFileRowDigest(path);
}

function fileRecordChanged(before: FileRecord, after: FileRecord): boolean {
  return fileRecordImage(before) !== fileRecordImage(after);
}
