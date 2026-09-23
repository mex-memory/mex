// Differential-test support: dump every derived graph table as sorted,
// id-stable row sets so two stores built by different code paths can be
// compared for exact equality.
//
// Surrogate keys (edge/ref/chunk ids, fingerprint refs, node rowids) and
// operational timestamps (updated_at, indexed_at, created_at, the snapshot's
// indexedAt/lastSuccessfulIndexAt) are the only columns left out. Everything
// that joins through a surrogate key is re-expressed through the stable key it
// stands for, and FTS content is read back term by term through fts5vocab.

import { openSqlite, type SqliteDatabase } from "../db/sqlite.js";
import { GRAPH_SNAPSHOT_METADATA_KEY } from "../snapshot.js";

export interface GraphDump {
  files: string[];
  /** `files` without the filesystem mtime, for comparing stores of different checkouts. */
  fileContents: string[];
  nodes: string[];
  edges: string[];
  importBindings: string[];
  unresolvedRefs: string[];
  fingerprints: string[];
  lshBuckets: string[];
  aliases: string[];
  sourceChunks: string[];
  sourceChunksFts: string[];
  nodesFts: string[];
  metadata: string[];
}

function rows(db: SqliteDatabase, sql: string): string[] {
  return (db.prepare(sql).all() as Array<Record<string, unknown>>)
    .map((row) => JSON.stringify(row, (_key, value: unknown) => (
      typeof value === "bigint" ? value.toString() : value
    )))
    .sort();
}

function metadataRows(db: SqliteDatabase): string[] {
  const entries = db.prepare("SELECT key, value FROM project_metadata").all() as Array<{ key: string; value: string }>;
  return entries.map(({ key, value }) => {
    if (key === GRAPH_SNAPSHOT_METADATA_KEY) {
      const snapshot = JSON.parse(value) as Record<string, unknown>;
      delete snapshot.indexedAt;
      delete snapshot.lastSuccessfulIndexAt;
      return JSON.stringify({ key, value: snapshot });
    }
    return JSON.stringify({ key, value });
  }).sort();
}

export function dumpGraphDatabase(path: string): GraphDump {
  const db = openSqlite(path);
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.dump_source_vocab USING fts5vocab(main, source_chunks_fts, instance)");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.dump_nodes_vocab USING fts5vocab(main, nodes_fts, instance)");
    return {
      files: rows(db, `SELECT path, content_hash, language, size, modified_at, node_count, errors, parse_status,
        diagnostic_count, missing_count, error_coverage, extractor_version FROM files`),
      fileContents: rows(db, `SELECT path, content_hash, language, size, node_count, errors, parse_status,
        diagnostic_count, missing_count, error_coverage, extractor_version FROM files`),
      nodes: rows(db, `SELECT id, kind, name, qualified_name, container_id, identity_key, file_path, language,
        start_line, end_line, start_column, end_column, docstring, signature, visibility, is_exported,
        is_async, is_static, is_abstract, decorators, type_parameters, return_type, body_hash FROM nodes`),
      edges: rows(db, `SELECT source, target, kind, metadata, line, col, provenance, confidence,
        resolution_method, evidence FROM edges`),
      importBindings: rows(db, "SELECT * FROM import_bindings"),
      unresolvedRefs: rows(db, `SELECT ref_key, from_node_id, reference_name, reference_kind, line, col,
        candidates, file_path, language, receiver, qualifier, import_source, metadata, status, target_id,
        confidence, resolver FROM unresolved_refs`),
      fingerprints: rows(db, "SELECT node_id, hex(minhash) AS minhash, neighbors, token_count FROM node_fingerprints"),
      lshBuckets: rows(db, `SELECT l.band, CAST(l.band_hash AS TEXT) AS band_hash, f.node_id FROM lsh_buckets l
        LEFT JOIN node_fingerprints f ON f.ref = l.ref`),
      aliases: rows(db, "SELECT alias_id, canonical_node_id, match_method, confidence FROM node_aliases"),
      sourceChunks: rows(db, `SELECT file_path, start_line, end_line, content_hash, path_terms,
        identifier_terms, comment_terms FROM source_chunks`),
      sourceChunksFts: rows(db, `SELECT v.term, v.col, v.offset, c.file_path, c.start_line, c.end_line
        FROM temp.dump_source_vocab v LEFT JOIN source_chunks c ON c.id = v.doc`),
      nodesFts: rows(db, `SELECT v.term, v.col, v.offset, n.id FROM temp.dump_nodes_vocab v
        LEFT JOIN nodes n ON n.rowid = v.doc`),
      metadata: metadataRows(db),
    };
  } finally {
    db.close();
  }
}

/** Table names whose dumps differ, with a bounded sample of each side's extra rows. */
export function diffGraphDumps(
  left: GraphDump,
  right: GraphDump,
  tables: readonly (keyof GraphDump)[] = Object.keys(left) as (keyof GraphDump)[],
): Array<{ table: keyof GraphDump; onlyLeft: string[]; onlyRight: string[] }> {
  const differences: Array<{ table: keyof GraphDump; onlyLeft: string[]; onlyRight: string[] }> = [];
  for (const table of tables) {
    const leftRows = new Set(left[table]);
    const rightRows = new Set(right[table]);
    const onlyLeft = left[table].filter((row) => !rightRows.has(row));
    const onlyRight = right[table].filter((row) => !leftRows.has(row));
    if (onlyLeft.length > 0 || onlyRight.length > 0 || left[table].length !== right[table].length) {
      differences.push({ table, onlyLeft: onlyLeft.slice(0, 5), onlyRight: onlyRight.slice(0, 5) });
    }
  }
  return differences;
}
