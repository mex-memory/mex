// ============================================================================
// mex code-graph — persistence + read queries  (A3)
// ============================================================================
//
// All SQL over the graph DB: node/edge/file/unresolved-ref writes, the reader
// queries the `GraphEngine` surface needs (getNode, search, incoming/outgoing
// edges), and the bulk reads resolution uses. Rows are snake_case in SQLite and
// decoded to the camelCase `GraphNode`/`GraphEdge` value types here.

import { createHash } from "node:crypto";
import type { EdgeKind, GraphEdge, GraphNode, Language, NodeKind, ReferenceKind } from "../types.js";
import { identifierComponents, isLowValueGraphPath, planGraphQuery } from "../retrieval/query.js";
import type { SqliteDatabase } from "./sqlite.js";

/** An unresolved reference row: a name a node points at, bound after indexing. */
export interface UnresolvedRefRecord {
  refKey?: string;
  fromNodeId: string;
  referenceName: string;
  referenceKind: ReferenceKind;
  filePath: string;
  language: Language;
  line?: number;
  column?: number;
  candidates?: string[];
  receiver?: string;
  qualifier?: string;
  importSource?: string;
  metadata?: Record<string, unknown>;
  status?: "pending" | "resolved" | "ambiguous" | "unresolved";
  targetId?: string;
  confidence?: number;
  resolver?: string;
}

/** A tracked-file row (drives incremental change detection for `sync`). */
export interface FileRecord {
  path: string;
  contentHash: string;
  language: Language;
  size: number;
  modifiedAt: number;
  indexedAt: number;
  nodeCount: number;
  errors?: Array<Record<string, unknown>>;
  parseStatus?: "ok" | "partial" | "failed";
  diagnosticCount?: number;
  missingCount?: number;
  errorCoverage?: number;
  extractorVersion?: string;
}

export interface ImportBindingRecord {
  bindingKey: string;
  filePath: string;
  localName: string;
  importedName: string;
  moduleSpecifier: string;
  resolvedFilePath?: string;
  targetId?: string;
  isTypeOnly?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SourceChunkHit {
  id: number;
  filePath: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  rank: number;
  matchedTerms: string[];
  nodeIds?: string[];
}

const SOURCE_CHUNK_NODE_LIMIT = 8;
const SOURCE_CHUNK_PRIMARY_KINDS = [
  "function", "method", "class", "component", "struct", "trait", "route",
] as const satisfies readonly NodeKind[];
const SOURCE_CHUNK_SECONDARY_KINDS = [
  "interface", "type_alias", "protocol", "enum",
] as const satisfies readonly NodeKind[];
const SOURCE_CHUNK_NODE_KINDS = [
  ...SOURCE_CHUNK_PRIMARY_KINDS, ...SOURCE_CHUNK_SECONDARY_KINDS,
] as const;

export interface GraphHealthSummary {
  indexedFiles: number;
  okFiles: number;
  partialFiles: number;
  failedFiles: number;
}

export interface NodeAliasRecord {
  aliasId: string;
  canonicalNodeId: string;
  matchMethod: string;
  confidence: number;
}

/** Reference edge kinds — everything except the intra-file `contains` edge.
 *  `sync` wipes these and rebuilds them from `unresolved_refs`. */
export const REFERENCE_EDGE_KINDS: EdgeKind[] = [
  "calls",
  "imports",
  "exports",
  "extends",
  "implements",
  "references",
  "type_of",
  "returns",
  "instantiates",
  "overrides",
  "decorates",
];

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  container_id: string | null;
  identity_key: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  return_type: string | null;
  body_hash: string | null;
  updated_at: number;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
  confidence: number;
  resolution_method: string | null;
  evidence: string | null;
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    containerId: row.container_id ?? undefined,
    identityKey: row.identity_key,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: (row.visibility as GraphNode["visibility"]) ?? undefined,
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: parseJson<string[]>(row.decorators),
    typeParameters: parseJson<string[]>(row.type_parameters),
    returnType: row.return_type ?? undefined,
    bodyHash: row.body_hash ?? undefined,
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: parseJson<Record<string, unknown>>(row.metadata),
    confidence: row.confidence,
    resolutionMethod: row.resolution_method ?? undefined,
    evidence: parseJson<Array<Record<string, unknown>>>(row.evidence),
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: (row.provenance as GraphEdge["provenance"]) ?? undefined,
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function edgeSupport(edge: GraphEdge): Record<string, unknown> {
  return canonicalJson({
    type: "resolution-support",
    confidence: edge.confidence ?? 1,
    ...(edge.provenance ? { provenance: edge.provenance } : {}),
    ...(edge.resolutionMethod ? { resolutionMethod: edge.resolutionMethod } : {}),
    ...(edge.metadata ? { metadata: edge.metadata } : {}),
  }) as Record<string, unknown>;
}

function mergedEdgeEvidence(left: GraphEdge, right: GraphEdge): Array<Record<string, unknown>> {
  const entries = [
    ...(left.evidence ?? []),
    edgeSupport(left),
    ...(right.evidence ?? []),
    edgeSupport(right),
  ];
  return [...new Map(entries.map((entry) => [canonicalString(entry), canonicalJson(entry) as Record<string, unknown>]))
    .entries()]
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([, entry]) => entry);
}

function strongerEdge(left: GraphEdge, right: GraphEdge): GraphEdge {
  const confidenceDelta = (right.confidence ?? 1) - (left.confidence ?? 1);
  if (confidenceDelta > 0) return right;
  if (confidenceDelta < 0) return left;
  return canonicalString(edgeSupport(right)) < canonicalString(edgeSupport(left)) ? right : left;
}

export class GraphStore {
  constructor(private readonly db: SqliteDatabase) {}

  /** Run `fn` inside a single transaction (bulk-write speed + atomicity). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // --- Writes ---------------------------------------------------------------

  insertNode(node: GraphNode): void {
    this.db
      .prepare(
        `INSERT INTO nodes (
           id, kind, name, qualified_name, container_id, identity_key, file_path, language,
           start_line, end_line, start_column, end_column,
           docstring, signature, visibility,
           is_exported, is_async, is_static, is_abstract,
           decorators, type_parameters, return_type, body_hash, updated_at
         ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           qualified_name = excluded.qualified_name,
           container_id = excluded.container_id,
           identity_key = excluded.identity_key,
           file_path = excluded.file_path,
           language = excluded.language,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           start_column = excluded.start_column,
           end_column = excluded.end_column,
           docstring = excluded.docstring,
           signature = excluded.signature,
           visibility = excluded.visibility,
           is_exported = excluded.is_exported,
           is_async = excluded.is_async,
           is_static = excluded.is_static,
           is_abstract = excluded.is_abstract,
           decorators = excluded.decorators,
           type_parameters = excluded.type_parameters,
           return_type = excluded.return_type,
           body_hash = excluded.body_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        node.id,
        node.kind,
        node.name,
        node.qualifiedName ?? node.name,
        node.containerId ?? null,
        node.identityKey ?? node.id,
        node.filePath,
        node.language,
        node.startLine,
        node.endLine,
        node.startColumn,
        node.endColumn,
        node.docstring ?? null,
        node.signature ?? null,
        node.visibility ?? null,
        node.isExported ? 1 : 0,
        node.isAsync ? 1 : 0,
        node.isStatic ? 1 : 0,
        node.isAbstract ? 1 : 0,
        node.decorators ? JSON.stringify(node.decorators) : null,
        node.typeParameters ? JSON.stringify(node.typeParameters) : null,
        node.returnType ?? null,
        node.bodyHash ?? null,
        node.updatedAt,
      );
  }

  /** Rebuild the external-content FTS index from the final nodes table. */
  rebuildSearchIndex(): void {
    this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  }

  /** Insert an edge, skipping it unless both endpoints exist (FK safety). */
  insertEdge(edge: GraphEdge): boolean {
    const existingRow = this.db.prepare(
      `SELECT * FROM edges
       WHERE source = ? AND target = ? AND kind = ?
         AND IFNULL(line, -1) = IFNULL(?, -1)
         AND IFNULL(col, -1) = IFNULL(?, -1)
       LIMIT 1`,
    ).get(edge.source, edge.target, edge.kind, edge.line ?? null, edge.column ?? null) as EdgeRow | undefined;

    if (existingRow) {
      const existing = rowToEdge(existingRow);
      const winner = strongerEdge(existing, edge);
      this.db.prepare(
        `UPDATE edges SET metadata = ?, provenance = ?, confidence = ?,
           resolution_method = ?, evidence = ?
         WHERE source = ? AND target = ? AND kind = ?
           AND IFNULL(line, -1) = IFNULL(?, -1)
           AND IFNULL(col, -1) = IFNULL(?, -1)`,
      ).run(
        winner.metadata ? canonicalString(winner.metadata) : null,
        winner.provenance ?? null,
        winner.confidence ?? 1,
        winner.resolutionMethod ?? null,
        canonicalString(mergedEdgeEvidence(existing, edge)),
        edge.source,
        edge.target,
        edge.kind,
        edge.line ?? null,
        edge.column ?? null,
      );
      return false;
    }

    const result = this.db
      .prepare(
        `INSERT INTO edges (
           source, target, kind, metadata, line, col, provenance,
           confidence, resolution_method, evidence
         ) SELECT ?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?)
           AND EXISTS (SELECT 1 FROM nodes WHERE id = ?)`,
      )
      .run(
        edge.source,
        edge.target,
        edge.kind,
        edge.metadata ? canonicalString(edge.metadata) : null,
        edge.line ?? null,
        edge.column ?? null,
        edge.provenance ?? null,
        edge.confidence ?? 1,
        edge.resolutionMethod ?? null,
        canonicalString(mergedEdgeEvidence(edge, edge)),
        edge.source,
        edge.target,
      );
    return result.changes > 0;
  }

  upsertFile(file: FileRecord): void {
    this.db
      .prepare(
        `INSERT INTO files (
           path, content_hash, language, size, modified_at, indexed_at, node_count,
           errors, parse_status, diagnostic_count, missing_count, error_coverage, extractor_version
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET
           content_hash = excluded.content_hash,
           language = excluded.language,
           size = excluded.size,
           modified_at = excluded.modified_at,
           indexed_at = excluded.indexed_at,
           node_count = excluded.node_count,
           errors = excluded.errors,
           parse_status = excluded.parse_status,
           diagnostic_count = excluded.diagnostic_count,
           missing_count = excluded.missing_count,
           error_coverage = excluded.error_coverage,
           extractor_version = excluded.extractor_version`,
      )
      .run(
        file.path,
        file.contentHash,
        file.language,
        file.size,
        file.modifiedAt,
        file.indexedAt,
        file.nodeCount,
        file.errors ? JSON.stringify(file.errors) : null,
        file.parseStatus ?? "ok",
        file.diagnosticCount ?? 0,
        file.missingCount ?? 0,
        file.errorCoverage ?? 0,
        file.extractorVersion ?? "tree-sitter",
      );
  }

  insertUnresolvedRef(ref: UnresolvedRefRecord): void {
    this.db
      .prepare(
        `INSERT INTO unresolved_refs (
           ref_key, from_node_id, reference_name, reference_kind, line, col,
           candidates, file_path, language, receiver, qualifier, import_source,
           metadata, status, target_id, confidence, resolver
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ref_key) DO UPDATE SET
           candidates = excluded.candidates,
           receiver = excluded.receiver,
           qualifier = excluded.qualifier,
           import_source = excluded.import_source,
           metadata = excluded.metadata,
           status = excluded.status,
           target_id = excluded.target_id,
           confidence = excluded.confidence,
           resolver = excluded.resolver`,
      )
      .run(
        ref.refKey ?? referenceKey(ref),
        ref.fromNodeId,
        ref.referenceName,
        ref.referenceKind,
        ref.line ?? 0,
        ref.column ?? 0,
        ref.candidates ? JSON.stringify(ref.candidates) : null,
        ref.filePath,
        ref.language,
        ref.receiver ?? null,
        ref.qualifier ?? null,
        ref.importSource ?? null,
        ref.metadata ? JSON.stringify(ref.metadata) : null,
        ref.status ?? "pending",
        ref.targetId ?? null,
        ref.confidence ?? null,
        ref.resolver ?? null,
      );
  }

  updateReferenceResolution(ref: UnresolvedRefRecord): void {
    const key = ref.refKey ?? referenceKey(ref);
    this.db.prepare(
      `UPDATE unresolved_refs SET status = ?, target_id = ?, confidence = ?, resolver = ?, candidates = ?
       WHERE ref_key = ?`,
    ).run(
      ref.status ?? "unresolved", ref.targetId ?? null, ref.confidence ?? null,
      ref.resolver ?? null, ref.candidates ? JSON.stringify(ref.candidates) : null, key,
    );
  }

  insertImportBinding(binding: ImportBindingRecord): void {
    this.db.prepare(
      `INSERT INTO import_bindings (
         binding_key, file_path, local_name, imported_name, module_specifier,
         resolved_file_path, target_id, is_type_only, metadata
       ) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(binding_key) DO UPDATE SET
         resolved_file_path = excluded.resolved_file_path,
         target_id = excluded.target_id,
         metadata = excluded.metadata`,
    ).run(
      binding.bindingKey, binding.filePath, binding.localName, binding.importedName,
      binding.moduleSpecifier, binding.resolvedFilePath ?? null, binding.targetId ?? null,
      binding.isTypeOnly ? 1 : 0, binding.metadata ? JSON.stringify(binding.metadata) : null,
    );
  }

  insertAlias(aliasId: string, canonicalNodeId: string, matchMethod: string, confidence: number): boolean {
    if (aliasId === canonicalNodeId) return false;
    return this.db.prepare(
      `INSERT INTO node_aliases (alias_id, canonical_node_id, match_method, confidence, created_at)
       SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?)
       ON CONFLICT(alias_id) DO UPDATE SET
         canonical_node_id = excluded.canonical_node_id,
         match_method = excluded.match_method,
         confidence = excluded.confidence`,
    ).run(aliasId, canonicalNodeId, matchMethod, confidence, Date.now(), canonicalNodeId).changes > 0;
  }

  /** Replace one file's overlapping source windows and contentless FTS rows. */
  replaceSourceChunks(filePath: string, source: string, contentHash: string): number {
    this.deleteSourceChunks(filePath);
    const lines = source.split("\n");
    const windowSize = 80;
    const stride = 60;
    let count = 0;
    for (let offset = 0; offset < Math.max(1, lines.length); offset += stride) {
      const chunk = lines.slice(offset, offset + windowSize);
      if (chunk.length === 0) break;
      const text = chunk.join("\n");
      const startLine = offset + 1;
      const endLine = offset + chunk.length;
      const pathTerms = splitIndexTerms(filePath).join(" ");
      const identifierTerms = splitIndexTerms(text).join(" ");
      const commentTerms = chunk.filter(isCommentLine).join(" ");
      const inserted = this.db.prepare(
        `INSERT INTO source_chunks (
           file_path, start_line, end_line, content_hash, path_terms, identifier_terms, comment_terms
         ) VALUES (?,?,?,?,?,?,?)`,
      ).run(filePath, startLine, endLine, contentHash, pathTerms, identifierTerms, commentTerms);
      this.db.prepare(
        `INSERT INTO source_chunks_fts (
           rowid, path_terms, identifier_terms, comment_terms, source_text
         ) VALUES (?,?,?,?,?)`,
      ).run(inserted.lastInsertRowid, pathTerms, identifierTerms, commentTerms, text);
      count++;
      if (endLine >= lines.length) break;
    }
    return count;
  }

  deleteSourceChunks(filePath: string): void {
    const rows = this.db.prepare("SELECT id FROM source_chunks WHERE file_path = ?").all(filePath) as Array<{ id: number }>;
    for (const row of rows) this.db.prepare("DELETE FROM source_chunks_fts WHERE rowid = ?").run(row.id);
    this.db.prepare("DELETE FROM source_chunks WHERE file_path = ?").run(filePath);
  }

  searchSourceChunks(query: string, limit = 40): SourceChunkHit[] {
    const terms = planGraphQuery(query).terms.slice(0, 32);
    if (terms.length === 0) return [];
    const fused = new Map<number, SourceChunkHit & { rrf: number }>();
    for (const term of terms) {
      const escaped = term.term.replaceAll('"', '');
      const match = term.term.length <= 3 ? `"${escaped}"` : `"${escaped}"*`;
      const rows = this.db.prepare(
        `SELECT c.id, c.file_path, c.start_line, c.end_line, c.content_hash,
                bm25(source_chunks_fts, 4, 2, 1, 3) AS rank
         FROM source_chunks_fts JOIN source_chunks c ON c.id = source_chunks_fts.rowid
         WHERE source_chunks_fts MATCH ? ORDER BY rank, c.file_path, c.start_line LIMIT ?`,
      ).all(match, Math.max(20, limit)) as Array<{
        id: number; file_path: string; start_line: number; end_line: number; content_hash: string; rank: number;
      }>;
      rows.forEach((row, index) => {
        const current = fused.get(row.id) ?? {
          id: row.id, filePath: row.file_path, startLine: row.start_line,
          endLine: row.end_line, contentHash: row.content_hash, rank: 0,
          matchedTerms: [], rrf: 0,
        };
        current.rrf += term.weight / (60 + index + 1);
        current.matchedTerms.push(term.term);
        fused.set(row.id, current);
      });
    }
    return [...fused.values()]
      .sort((left, right) => right.rrf - left.rrf || left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine)
      .slice(0, limit)
      .map(({ rrf, ...hit }) => {
        const nodeIds = this.sourceChunkNodeIds(hit.filePath, hit.startLine, hit.endLine);
        return {
          ...hit,
          rank: -rrf,
          matchedTerms: [...new Set(hit.matchedTerms)].sort(),
          ...(nodeIds.length > 0 ? { nodeIds } : {}),
        };
      });
  }

  private sourceChunkNodeIds(filePath: string, startLine: number, endLine: number): string[] {
    const kindPlaceholders = SOURCE_CHUNK_NODE_KINDS.map(() => "?").join(",");
    const primaryPlaceholders = SOURCE_CHUNK_PRIMARY_KINDS.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT id FROM nodes
       WHERE file_path = ?
         AND start_line <= ? AND end_line >= ?
         AND kind IN (${kindPlaceholders})
         AND trim(name) <> '' AND name NOT LIKE '<%'
       ORDER BY
         CASE WHEN kind IN (${primaryPlaceholders}) THEN 0 ELSE 1 END,
         (min(end_line, ?) - max(start_line, ?) + 1) DESC,
         (end_line - start_line) ASC,
         start_line ASC,
         end_line ASC,
         id ASC
       LIMIT ?`,
    ).all(
      filePath, endLine, startLine,
      ...SOURCE_CHUNK_NODE_KINDS,
      ...SOURCE_CHUNK_PRIMARY_KINDS,
      endLine, startLine,
      SOURCE_CHUNK_NODE_LIMIT,
    ) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** Delete all nodes for a file (ON DELETE CASCADE clears their edges +
   *  unresolved refs). Used by `sync` before re-indexing a changed file. */
  deleteNodesByFile(filePath: string): void {
    this.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
  }

  deleteFile(filePath: string): void {
    this.deleteSourceChunks(filePath);
    this.db.prepare("DELETE FROM import_bindings WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
    this.deleteNodesByFile(filePath);
  }

  /** Clear only derived graph/index rows; authored grounding snapshots survive. */
  clearDerivedGraph(): void {
    this.db.exec("DELETE FROM source_chunks_fts");
    this.db.exec("DELETE FROM source_chunks");
    this.db.exec("DELETE FROM import_bindings");
    this.db.exec("DELETE FROM node_aliases");
    // Clear fingerprint dependents in bulk before deleting nodes. Relying on
    // the node FK cascade here makes SQLite scan the large LSH table once per
    // node because its lookup index is band-oriented rather than node-oriented.
    this.db.exec("DELETE FROM lsh_buckets");
    this.db.exec("DELETE FROM node_fingerprints");
    this.db.exec("DELETE FROM nodes");
    this.db.exec("DELETE FROM files");
  }

  /** Wipe every reference edge (keeping intra-file `contains`), so `sync` can
   *  rebuild them from `unresolved_refs` with no duplicates. */
  clearReferenceEdges(): void {
    this.db.prepare("DELETE FROM edges WHERE kind != 'contains'").run();
  }

  // --- Reads ----------------------------------------------------------------

  getNodeById(id: string): GraphNode | null {
    const row = this.db.prepare(
      `SELECT nodes.* FROM nodes WHERE nodes.id = ?
       UNION ALL
       SELECT nodes.* FROM node_aliases JOIN nodes ON nodes.id = node_aliases.canonical_node_id
       WHERE node_aliases.alias_id = ? LIMIT 1`,
    ).get(id, id) as
      | NodeRow
      | undefined;
    return row ? rowToNode(row) : null;
  }

  getAllNodes(): GraphNode[] {
    return (this.db.prepare("SELECT * FROM nodes").all() as NodeRow[]).map(rowToNode);
  }

  /**
   * Bulk edge read for corpus-wide consumers such as fingerprint generation.
   * Keeping this as one indexed query avoids an incoming + outgoing SQL pair
   * for every node while preserving the same edge decoding as point reads.
   */
  getAllEdges(kinds?: readonly EdgeKind[]): GraphEdge[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      return (this.db.prepare(
        `SELECT * FROM edges WHERE kind IN (${placeholders}) ORDER BY source, target, kind, id`,
      ).all(...kinds) as EdgeRow[]).map(rowToEdge);
    }
    return (this.db.prepare(
      "SELECT * FROM edges ORDER BY source, target, kind, id",
    ).all() as EdgeRow[]).map(rowToEdge);
  }

  getAllAliases(): NodeAliasRecord[] {
    return (this.db.prepare(
      "SELECT alias_id, canonical_node_id, match_method, confidence FROM node_aliases ORDER BY alias_id",
    ).all() as Array<{
      alias_id: string; canonical_node_id: string; match_method: string; confidence: number;
    }>).map((row) => ({
      aliasId: row.alias_id,
      canonicalNodeId: row.canonical_node_id,
      matchMethod: row.match_method,
      confidence: row.confidence,
    }));
  }

  getAllUnresolvedRefs(): UnresolvedRefRecord[] {
    const rows = this.db.prepare("SELECT * FROM unresolved_refs").all() as Array<{
      ref_key: string;
      from_node_id: string;
      reference_name: string;
      reference_kind: string;
      line: number;
      col: number;
      candidates: string | null;
      file_path: string;
      language: string;
      receiver: string | null;
      qualifier: string | null;
      import_source: string | null;
      metadata: string | null;
      status: "pending" | "resolved" | "ambiguous" | "unresolved";
      target_id: string | null;
      confidence: number | null;
      resolver: string | null;
    }>;
    return rows.map((r) => ({
      refKey: r.ref_key,
      fromNodeId: r.from_node_id,
      referenceName: r.reference_name,
      referenceKind: r.reference_kind as ReferenceKind,
      line: r.line,
      column: r.col,
      candidates: parseJson<string[]>(r.candidates),
      filePath: r.file_path,
      language: r.language as Language,
      receiver: r.receiver ?? undefined,
      qualifier: r.qualifier ?? undefined,
      importSource: r.import_source ?? undefined,
      metadata: parseJson<Record<string, unknown>>(r.metadata),
      status: r.status,
      targetId: r.target_id ?? undefined,
      confidence: r.confidence ?? undefined,
      resolver: r.resolver ?? undefined,
    }));
  }

  getFileRecord(path: string): FileRecord | null {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as
      | {
          path: string;
          content_hash: string;
          language: string;
          size: number;
          modified_at: number;
          indexed_at: number;
          node_count: number;
          errors: string | null;
          parse_status: "ok" | "partial" | "failed";
          diagnostic_count: number;
          missing_count: number;
          error_coverage: number;
          extractor_version: string;
        }
      | undefined;
    if (!row) return null;
    return {
      path: row.path,
      contentHash: row.content_hash,
      language: row.language as Language,
      size: row.size,
      modifiedAt: row.modified_at,
      indexedAt: row.indexed_at,
      nodeCount: row.node_count,
      errors: parseJson<Array<Record<string, unknown>>>(row.errors),
      parseStatus: row.parse_status,
      diagnosticCount: row.diagnostic_count,
      missingCount: row.missing_count,
      errorCoverage: row.error_coverage,
      extractorVersion: row.extractor_version,
    };
  }

  getAllFileRecords(): FileRecord[] {
    const rows = this.db.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>;
    return rows.map((row) => this.getFileRecord(row.path)).filter((row): row is FileRecord => row !== null);
  }

  getHealthSummary(): GraphHealthSummary {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS indexed,
              SUM(CASE WHEN parse_status = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN parse_status = 'partial' THEN 1 ELSE 0 END) AS partial,
              SUM(CASE WHEN parse_status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM files`,
    ).get() as { indexed: number; ok: number | null; partial: number | null; failed: number | null };
    return {
      indexedFiles: row.indexed,
      okFiles: row.ok ?? 0,
      partialFiles: row.partial ?? 0,
      failedFiles: row.failed ?? 0,
    };
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO project_metadata (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, Date.now());
  }

  getMetadata(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM project_metadata WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  validateInvariants(expectedNodes?: number): { nodes: number; duplicateEdges: number; danglingEdges: number } {
    const nodes = (this.db.prepare("SELECT COUNT(*) AS count FROM nodes").get() as { count: number }).count;
    const duplicateEdges = (this.db.prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT 1 FROM edges GROUP BY source,target,kind,IFNULL(line,-1),IFNULL(col,-1) HAVING COUNT(*) > 1
       )`,
    ).get() as { count: number }).count;
    const danglingEdges = (this.db.prepare(
      `SELECT COUNT(*) AS count FROM edges e
       LEFT JOIN nodes s ON s.id=e.source LEFT JOIN nodes t ON t.id=e.target
       WHERE s.id IS NULL OR t.id IS NULL`,
    ).get() as { count: number }).count;
    if (expectedNodes !== undefined && nodes !== expectedNodes) {
      throw new Error(`Graph invariant failed: emitted ${expectedNodes} nodes but stored ${nodes}.`);
    }
    if (duplicateEdges > 0 || danglingEdges > 0) {
      throw new Error(`Graph invariant failed: ${duplicateEdges} duplicate and ${danglingEdges} dangling edges.`);
    }
    return { nodes, duplicateEdges, danglingEdges };
  }

  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): GraphEdge[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM edges WHERE target = ? AND kind IN (${placeholders}) ORDER BY source, target, kind`)
        .all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }
    return (
      this.db
        .prepare("SELECT * FROM edges WHERE target = ? ORDER BY source, target, kind")
        .all(targetId) as EdgeRow[]
    ).map(rowToEdge);
  }

  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[]): GraphEdge[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM edges WHERE source = ? AND kind IN (${placeholders}) ORDER BY source, target, kind`)
        .all(sourceId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }
    return (
      this.db
        .prepare("SELECT * FROM edges WHERE source = ? ORDER BY source, target, kind")
        .all(sourceId) as EdgeRow[]
    ).map(rowToEdge);
  }

  /** Batch node lookup by id (one round-trip), keyed by id. */
  getNodesByIds(ids: readonly string[]): Map<string, GraphNode> {
    const out = new Map<string, GraphNode>();
    if (ids.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) out.set(row.id, rowToNode(row));
    }
    return out;
  }

  /**
   * Full-text search over node name/qualified-name/docstring/signature (FTS5),
   * with a LIKE fallback for substrings FTS's prefix match misses. Backs
   * `searchNodes` on the engine surface.
   */
  search(
    query: string,
    options: { kinds?: NodeKind[]; languages?: Language[]; limit?: number } = {},
  ): GraphNode[] {
    const { kinds, languages, limit = 100 } = options;
    const plan = planGraphQuery(query);
    const searchableTerms = [...new Set(plan.terms.map((entry) => entry.term))];
    const ftsQuery = searchableTerms
      .map((term) => `"${term.replaceAll('"', '')}"*`)
      .join(" OR ");

    const filterSql: string[] = [];
    const filterParams: Array<string | number> = [];
    if (kinds && kinds.length > 0) {
      filterSql.push(`nodes.kind IN (${kinds.map(() => "?").join(",")})`);
      filterParams.push(...kinds);
    }
    if (languages && languages.length > 0) {
      filterSql.push(`nodes.language IN (${languages.map(() => "?").join(",")})`);
      filterParams.push(...languages);
    }
    const filterClause = filterSql.length > 0 ? ` AND ${filterSql.join(" AND ")}` : "";

    const fetchLimit = Math.max(100, limit * 5);
    const candidates = new Map<string, { row: NodeRow; ftsRank?: number; exact: boolean }>();
    if (ftsQuery) {
      // bm25 column weights bias toward name matches over incidental docstring
      // mentions. bm25 returns negative scores (more negative = better).
      const rows = this.db
        .prepare(
          `SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2) AS fts_rank FROM nodes_fts
             JOIN nodes ON nodes_fts.id = nodes.id
             WHERE nodes_fts MATCH ?${filterClause}
             ORDER BY fts_rank, nodes.id LIMIT ?`,
        )
        .all(ftsQuery, ...filterParams, fetchLimit) as Array<NodeRow & { fts_rank: number }>;
      rows.forEach((row, index) => candidates.set(row.id, { row, ftsRank: index, exact: false }));
    }

    // Exact declarations are a separate retrieval channel. They must not be
    // allowed to fall below an FTS fetch cut because their signatures are short.
    const exactTerms = [...new Set([
      ...plan.explicitIdentifiers.map((entry) => entry.toLowerCase()),
      ...plan.terms.filter((entry) => !entry.stem).map((entry) => entry.term),
    ])].slice(0, 24);
    if (exactTerms.length > 0) {
      const placeholders = exactTerms.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT * FROM nodes WHERE lower(name) IN (${placeholders})${filterClause}
         ORDER BY length(name), name, id LIMIT ?`,
      ).all(...exactTerms, ...filterParams, fetchLimit) as NodeRow[];
      for (const row of rows) {
        const current = candidates.get(row.id);
        candidates.set(row.id, { row, ftsRank: current?.ftsRank, exact: true });
      }
    }

    // FTS prefix matching cannot see `ledger` inside `BudgetLedger`. Always
    // supplement it with component/substring candidates; doing this only when
    // FTS returned zero is what previously made incidental signature hits win.
    const componentTerms = [...new Set(plan.terms
      .filter((entry) => entry.term.length >= 3 && !entry.stem)
      .map((entry) => entry.term))]
      .slice(0, 16);
    if (componentTerms.length > 0) {
      const clauses = componentTerms.map(() => "(lower(name) LIKE ? OR lower(qualified_name) LIKE ?)");
      const patterns = componentTerms.flatMap((term) => [`%${term}%`, `%${term}%`]);
      const rows = this.db.prepare(
        `SELECT * FROM nodes WHERE (${clauses.join(" OR ")})${filterClause}
         ORDER BY length(name), name, id LIMIT ?`,
      ).all(...patterns, ...filterParams, fetchLimit) as NodeRow[];
      for (const row of rows) {
        if (!candidates.has(row.id)) candidates.set(row.id, { row, exact: false });
      }
    }

    const totalWeight = plan.terms.reduce((sum, entry) => sum + entry.weight, 0) || 1;
    const kindWeight: Partial<Record<NodeKind, number>> = {
      function: 1, method: 1, class: 0.95, interface: 0.9, trait: 0.9,
      component: 0.9, route: 0.9, struct: 0.85, type_alias: 0.75,
      enum: 0.65, constant: 0.45, variable: 0.35, property: 0.3,
      field: 0.3, file: 0.15, parameter: 0.1, import: 0.05, export: 0.05,
    };
    const explicit = new Set(plan.explicitIdentifiers.map((entry) => entry.toLowerCase()));
    const scored = [...candidates.values()].map((candidate) => {
      const node = rowToNode(candidate.row);
      const name = node.name.toLowerCase();
      const qualified = node.qualifiedName.toLowerCase();
      const signature = node.signature?.toLowerCase() ?? "";
      const docstring = node.docstring?.toLowerCase() ?? "";
      const components = new Set(identifierComponents(node.name));
      let matchedWeight = 0;
      for (const entry of plan.terms) {
        if (components.has(entry.term) || name.includes(entry.term) || qualified.includes(entry.term)) {
          matchedWeight += entry.weight;
        } else if (docstring.includes(entry.term)) {
          matchedWeight += entry.weight * 0.65;
        } else if (signature.includes(entry.term)) {
          matchedWeight += entry.weight * 0.45;
        }
      }
      const coverage = Math.min(1, matchedWeight / totalWeight);
      const fts = candidate.ftsRank === undefined ? 0 : 1 / Math.log2(candidate.ftsRank + 2);
      const explicitExact = explicit.has(name) || explicit.has(qualified) ? 1 : 0;
      const exact = candidate.exact ? 1 : 0;
      let score = explicitExact * 4 + coverage * 2.4 + fts * 1.2 + exact * 0.35 + (kindWeight[node.kind] ?? 0.2);
      if (!plan.asksForTests && isLowValueGraphPath(node.filePath)) score *= 0.12;
      return { node, score };
    });

    return scored
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
      .slice(0, limit)
      .map((entry) => entry.node);
  }
}

function referenceKey(ref: UnresolvedRefRecord): string {
  const material = [
    ref.filePath, ref.fromNodeId, ref.referenceKind, ref.referenceName,
    ref.receiver ?? "", ref.qualifier ?? "", ref.line ?? 0, ref.column ?? 0,
  ].join("\0");
  return `ref:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

function splitIndexTerms(value: string): string[] {
  const terms = new Set<string>();
  for (const token of value.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    for (const component of identifierComponents(token)) terms.add(component);
  }
  return [...terms];
}

function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*|#|<!--)/.test(line);
}
