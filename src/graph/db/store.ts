// ============================================================================
// mex code-graph — persistence + read queries  (A3)
// ============================================================================
//
// All SQL over the graph DB: node/edge/file/unresolved-ref writes, the reader
// queries the `GraphEngine` surface needs (getNode, search, incoming/outgoing
// edges), and the bulk reads resolution uses. Rows are snake_case in SQLite and
// decoded to the camelCase `GraphNode`/`GraphEdge` value types here.

import type { EdgeKind, GraphEdge, GraphNode, Language, NodeKind } from "../types.js";
import type { SqliteDatabase } from "./sqlite.js";

/** An unresolved reference row: a name a node points at, bound after indexing. */
export interface UnresolvedRefRecord {
  fromNodeId: string;
  referenceName: string;
  referenceKind: string;
  filePath: string;
  language: Language;
  line?: number;
  column?: number;
  candidates?: string[];
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
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: (row.provenance as GraphEdge["provenance"]) ?? undefined,
  };
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
        `INSERT OR REPLACE INTO nodes (
           id, kind, name, qualified_name, file_path, language,
           start_line, end_line, start_column, end_column,
           docstring, signature, visibility,
           is_exported, is_async, is_static, is_abstract,
           decorators, type_parameters, return_type, body_hash, updated_at
         ) VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?,?)`,
      )
      .run(
        node.id,
        node.kind,
        node.name,
        node.qualifiedName ?? node.name,
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

  /** Insert an edge, skipping it unless both endpoints exist (FK safety). */
  insertEdge(edge: GraphEdge): void {
    this.db
      .prepare(
        `INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
         SELECT ?,?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?)
           AND EXISTS (SELECT 1 FROM nodes WHERE id = ?)`,
      )
      .run(
        edge.source,
        edge.target,
        edge.kind,
        edge.metadata ? JSON.stringify(edge.metadata) : null,
        edge.line ?? null,
        edge.column ?? null,
        edge.provenance ?? null,
        edge.source,
        edge.target,
      );
  }

  upsertFile(file: FileRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (
           path, content_hash, language, size, modified_at, indexed_at, node_count
         ) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        file.path,
        file.contentHash,
        file.language,
        file.size,
        file.modifiedAt,
        file.indexedAt,
        file.nodeCount,
      );
  }

  insertUnresolvedRef(ref: UnresolvedRefRecord): void {
    this.db
      .prepare(
        `INSERT INTO unresolved_refs (
           from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language
         ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        ref.fromNodeId,
        ref.referenceName,
        ref.referenceKind,
        ref.line ?? 0,
        ref.column ?? 0,
        ref.candidates ? JSON.stringify(ref.candidates) : null,
        ref.filePath,
        ref.language,
      );
  }

  /** Delete all nodes for a file (ON DELETE CASCADE clears their edges +
   *  unresolved refs). Used by `sync` before re-indexing a changed file. */
  deleteNodesByFile(filePath: string): void {
    this.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
  }

  /** Wipe every reference edge (keeping intra-file `contains`), so `sync` can
   *  rebuild them from `unresolved_refs` with no duplicates. */
  clearReferenceEdges(): void {
    this.db.prepare("DELETE FROM edges WHERE kind != 'contains'").run();
  }

  // --- Reads ----------------------------------------------------------------

  getNodeById(id: string): GraphNode | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | NodeRow
      | undefined;
    return row ? rowToNode(row) : null;
  }

  getAllNodes(): GraphNode[] {
    return (this.db.prepare("SELECT * FROM nodes").all() as NodeRow[]).map(rowToNode);
  }

  getAllUnresolvedRefs(): UnresolvedRefRecord[] {
    const rows = this.db.prepare("SELECT * FROM unresolved_refs").all() as Array<{
      from_node_id: string;
      reference_name: string;
      reference_kind: string;
      line: number;
      col: number;
      candidates: string | null;
      file_path: string;
      language: string;
    }>;
    return rows.map((r) => ({
      fromNodeId: r.from_node_id,
      referenceName: r.reference_name,
      referenceKind: r.reference_kind,
      line: r.line,
      column: r.col,
      candidates: parseJson<string[]>(r.candidates),
      filePath: r.file_path,
      language: r.language as Language,
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
    };
  }

  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): GraphEdge[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM edges WHERE target = ? AND kind IN (${placeholders})`)
        .all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }
    return (this.db.prepare("SELECT * FROM edges WHERE target = ?").all(targetId) as EdgeRow[]).map(
      rowToEdge,
    );
  }

  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[]): GraphEdge[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM edges WHERE source = ? AND kind IN (${placeholders})`)
        .all(sourceId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }
    return (this.db.prepare("SELECT * FROM edges WHERE source = ?").all(sourceId) as EdgeRow[]).map(
      rowToEdge,
    );
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
    const ftsQuery = query
      .replace(/[."'*():^-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0 && !/^(AND|OR|NOT|NEAR)$/i.test(t))
      .map((t) => `"${t}"*`)
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

    let rows: NodeRow[] = [];
    if (ftsQuery) {
      // bm25 column weights bias toward name matches over incidental docstring
      // mentions. bm25 returns negative scores (more negative = better).
      rows = this.db
        .prepare(
          `SELECT nodes.* FROM nodes_fts
             JOIN nodes ON nodes_fts.id = nodes.id
             WHERE nodes_fts MATCH ?${filterClause}
             ORDER BY bm25(nodes_fts, 0, 20, 5, 1, 2) LIMIT ?`,
        )
        .all(ftsQuery, ...filterParams, limit) as NodeRow[];
    }

    if (rows.length === 0 && query.trim().length >= 2) {
      const like = `%${query.trim()}%`;
      rows = this.db
        .prepare(
          `SELECT * FROM nodes
             WHERE (name LIKE ? OR qualified_name LIKE ?)${filterClause}
             ORDER BY length(name) LIMIT ?`,
        )
        .all(like, like, ...filterParams, limit) as NodeRow[];
    }

    return rows.map(rowToNode);
  }
}
