// The read projection of the integer-key store. Views are connection-local;
// the engine's SQL schema and on-disk rows remain independent of Node.
import type { SqliteDatabase } from "./sqlite.js";

export const ENGINE_GRAPH_SCHEMA_VERSION = 5;
const projected = new WeakSet<object>();
const layered = new WeakSet<object>();

export function readsV5Overlay(db: object): boolean {
  return layered.has(db);
}

const CODE_TABLES = ["languages", "node_kinds", "edge_kinds", "provenances", "resolution_methods", "unresolved_reasons", "unresolved_names"];
const OWNED_KEYS = {
  files: "id", file_diagnostics: "file", file_resolution: "file", nodes: "file", node_attributes: "node",
  edges: "source", unresolved_calls: "source", unresolved_other: "source", fingerprints: "node",
  fingerprint_neighbours: "node", source_chunks: "file",
};

/** The engine's logical rows, including their integer-key joins. */
export function v5Rows(db: object, table: string): string {
  return layered.has(db) && (Object.hasOwn(OWNED_KEYS, table) || CODE_TABLES.includes(table))
    ? `temp.v5_${table}` : `main.${table}`;
}

/** Checkout-private stat memo. Sparse overlays inherit only the same root's stamps. */
export function v5SourceObservations(db: SqliteDatabase): string {
  if (!readsV5Overlay(db) || !db.prepare(`SELECT 1 FROM main.meta m JOIN base.meta b
      ON b.key = m.key AND b.value = m.value
      WHERE m.key = 'observation_root'
        AND EXISTS (SELECT 1 FROM main.meta WHERE key = 'source_observation_storage' AND value = 'sparse')`).get()) {
    return "main.source_observations";
  }
  return `(SELECT * FROM main.source_observations
    UNION ALL SELECT b.* FROM base.source_observations b
      WHERE NOT EXISTS (SELECT 1 FROM main.source_observations o WHERE o.path = b.path)
        AND NOT EXISTS (SELECT 1 FROM main.source_observation_gaps g WHERE g.path = b.path))`;
}

function installV5Union(db: SqliteDatabase): void {
  db.exec(`CREATE TEMP VIEW v5_shadowed_files AS
     SELECT f.id FROM main.shadow_files s CROSS JOIN base.files f ON f.path = s.path;
    CREATE TEMP VIEW v5_shadowed_nodes AS
     SELECT n.id FROM temp.v5_shadowed_files f CROSS JOIN base.nodes n ON n.file = f.id;`);
  const ownersByFile = new Set(["files", "file_diagnostics", "file_resolution", "nodes", "source_chunks"]);
  for (const [table, key] of Object.entries(OWNED_KEYS)) {
    const owners = ownersByFile.has(table) ? "files" : "nodes";
    db.exec(`CREATE TEMP VIEW v5_${table} AS
      SELECT * FROM main.${table} UNION ALL
      SELECT * FROM base.${table} WHERE ${key} NOT IN (SELECT id FROM temp.v5_shadowed_${owners})`);
  }
  for (const table of CODE_TABLES) {
    db.exec(`CREATE TEMP VIEW v5_${table} AS SELECT * FROM main.${table} UNION ALL SELECT * FROM base.${table}`);
  }
  layered.add(db);
}

export function hasV5GraphSchema(db: Pick<SqliteDatabase, "prepare">): boolean {
  const row = db.prepare("PRAGMA main.user_version").get() as { user_version?: number };
  return row.user_version === ENGINE_GRAPH_SCHEMA_VERSION;
}

export function readsV5Graph(db: object): boolean {
  return projected.has(db);
}

export function parseV5PublicId(id: string): { kind: string; digest: Buffer } | undefined {
  const match = /^([a-z_]+):([0-9a-f]{32})$/u.exec(id);
  return match ? { kind: match[1]!, digest: Buffer.from(match[2]!, "hex") } : undefined;
}

export function v5NodeKey(
  db: { prepare(sql: string): { get(...bindings: Array<string | Uint8Array>): unknown } },
  id: string,
): number | undefined {
  const parts = parseV5PublicId(id);
  if (!parts) return undefined;
  const row = db.prepare(
    `SELECT n.id FROM ${v5Rows(db, "nodes")} n JOIN ${v5Rows(db, "node_kinds")} k ON k.id = n.kind
     WHERE n.public_id = ? AND k.name = ?`,
  ).get(parts.digest, parts.kind) as { id: number } | undefined;
  return row?.id;
}

/** A shape check on the native tables before any view or reader uses them. */
export function inspectV5GraphSchema(db: SqliteDatabase, schema: "main" | "base" = "main"): string[] {
  const columns: Record<string, string> = {
    meta: "key value",
    languages: "id name",
    node_kinds: "id name",
    edge_kinds: "id name",
    provenances: "id name",
    resolution_methods: "id name",
    unresolved_reasons: "id name",
    unresolved_names: "id name",
    files: "id path content_hash language size modified_at parse_status error_count missing_count error_coverage extractor_version",
    file_diagnostics: "file position code start_line end_line",
    nodes: "id public_id kind file parent name qualified_name start_line start_col end_line end_col signature flags body_hash docstring visibility return_type",
    node_attributes: "node kind position value",
    edges: "source kind target line col site_file provenance confidence method target_name detail_kind detail argument sequence",
    unresolved_calls: "id source name kind reason line col candidate receiver written_name",
    unresolved_other: "id source name kind reason line col",
    fingerprints: "node minhash token_count",
    fingerprint_neighbours: "node neighbour",
    aliases: "old_public_id old_kind node match_method confidence",
    _mex_grounded_source: "subject_kind subject_id node_kind public_id source body_hash fingerprint",
    nodes_fts: "id name qualified_name docstring signature",
    source_chunks: "id file start_line end_line",
    source_chunks_fts: "path_terms identifier_terms comment_terms source_text",
    snapshot: "id indexed_at indexed_branch indexed_head compiler_version extractor_version resolver_version grammar_hash config_hash manifest_hash corpus_digest source_count partial_count failed_count",
    coverage: "path reason",
    coverage_summary: "id policy total truncated",
    coverage_extensions: "extension files",
    coverage_directories: "path stamp",
  };
  if (db.prepare(`SELECT 1 FROM ${schema}.sqlite_schema WHERE name = 'meta' AND type = 'table'`).get()
    && db.prepare(`SELECT 1 FROM ${schema}.meta WHERE key = 'refresh_format'`).get()) columns.file_resolution = "file digest";
  if (schema === "main" && db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name = 'overlay_info'").get()) {
    columns.overlay_info = "key value";
    columns.shadow_files = "path";
    columns.file_resolution = "file digest";
  }
  const inventory = db.prepare(`PRAGMA ${schema}.table_list`).iterate() as Iterable<{
    name: string; type: string; strict: number;
  }>;
  const expected = new Map(Object.keys(columns).map((table) => [table, false]));
  const fts = ["nodes_fts", "source_chunks_fts"];
  for (const table of fts) {
    for (const suffix of ["config", "data", "docsize", "idx"]) expected.set(`${table}_${suffix}`, false);
  }
  for (const row of inventory) {
    if (!expected.has(row.name)) continue;
    const kind = fts.includes(row.name) ? "virtual" : columns[row.name] ? "table" : "shadow";
    expected.set(row.name, row.type === kind && (kind !== "table" || row.strict === 1));
  }
  const failures: string[] = [];
  for (const [table, valid] of expected) if (!valid) failures.push(`missing or invalid table ${table}`);
  if (failures.length > 0) return failures;

  const tableColumns = db.prepare(`SELECT group_concat(name, ' ') AS names FROM pragma_table_info(?, '${schema}')`);
  for (const [table, required] of Object.entries(columns)) {
    const row = tableColumns.get(table) as { names: string | null };
    if (row.names !== required) failures.push(`incompatible columns in ${table}`);
  }
  const foreignKeys = db.prepare(`SELECT [from] AS owner, [table] AS target FROM pragma_foreign_key_list(?, '${schema}')`);
  for (const [table, required] of Object.entries({
    files: "language:languages", file_diagnostics: "file:files",
    nodes: "file:files kind:node_kinds parent:nodes", node_attributes: "node:nodes",
    edges: "source:nodes target:nodes kind:edge_kinds site_file:files provenance:provenances method:resolution_methods",
    unresolved_calls: "source:nodes candidate:nodes name:unresolved_names receiver:unresolved_names written_name:unresolved_names kind:edge_kinds reason:unresolved_reasons",
    unresolved_other: "source:nodes name:unresolved_names kind:edge_kinds reason:unresolved_reasons",
    fingerprints: "node:nodes", fingerprint_neighbours: "node:fingerprints neighbour:nodes",
    aliases: "old_kind:node_kinds node:nodes", source_chunks: "file:files",
  })) {
    const actual = new Set((foreignKeys.all(table) as Array<{ owner: string; target: string }>)
      .map(key => `${key.owner}:${key.target}`));
    if (required.split(" ").some(key => !actual.has(key))) failures.push(`incompatible foreign keys in ${table}`);
  }
  const index = db.prepare(`SELECT tbl_name FROM ${schema}.sqlite_schema WHERE type = 'index' AND name = ?`);
  for (const [name, table] of Object.entries({
    nodes_file_line: "nodes", nodes_name: "nodes", nodes_lower_name: "nodes", nodes_parent: "nodes",
    edges_target: "edges", unresolved_calls_name: "unresolved_calls", unresolved_calls_candidate: "unresolved_calls",
    unresolved_calls_written_name: "unresolved_calls", unresolved_calls_source: "unresolved_calls",
    unresolved_other_name: "unresolved_other",
    aliases_node: "aliases", grounded_body_hash: "_mex_grounded_source", source_chunks_file: "source_chunks",
  })) {
    if ((index.get(name) as { tbl_name: string } | undefined)?.tbl_name !== table) failures.push(`missing index ${name}`);
  }
  return failures;
}

export function inspectV5GraphInvariants(db: SqliteDatabase, schema: "main" | "base" = "main"): string[] {
  const overlay = schema === "main" && readsV5Overlay(db);
  const failures: string[] = [];
  if (!overlay && db.prepare(`PRAGMA ${schema}.foreign_key_check`).get()) failures.push("dangling integer reference");
  // quick_check checks SQLite's records and CHECKs. These checks bind facts
  // used across tables and ensure every indexed row can be searched.
  const checks: Record<string, string> = {
    "inconsistent schema version": "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM main.meta WHERE key = 'schema_version' AND value = '5')",
    "missing graph snapshot": "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM main.snapshot WHERE id = 1)",
    "invalid node container": "SELECT 1 FROM main.nodes n JOIN main.nodes p ON p.id = n.parent WHERE n.file <> p.file OR n.id = p.id",
    "invalid unresolved call kind": "SELECT 1 FROM main.unresolved_calls u JOIN main.edge_kinds k ON k.id = u.kind WHERE k.name NOT IN ('calls', 'instantiates')",
    "call stored outside unresolved_calls": "SELECT 1 FROM main.unresolved_other u JOIN main.edge_kinds k ON k.id = u.kind WHERE k.name IN ('calls', 'instantiates')",
    "fingerprint on a node without a body": "SELECT 1 FROM main.fingerprints f JOIN main.nodes n ON n.id = f.node WHERE n.body_hash IS NULL",
    "fingerprint neighbour without a call": `SELECT 1 FROM main.fingerprint_neighbours f
      WHERE NOT EXISTS (SELECT 1 FROM main.edges e WHERE e.source = f.node AND e.target = f.neighbour
        AND e.kind = (SELECT id FROM main.edge_kinds WHERE name = 'calls'))
      AND NOT EXISTS (SELECT 1 FROM main.edges e WHERE e.source = f.neighbour AND e.target = f.node
        AND e.kind = (SELECT id FROM main.edge_kinds WHERE name = 'calls'))`,
    "call missing from fingerprint neighbours": `SELECT 1 FROM main.edges e
      LEFT JOIN main.fingerprints source ON source.node = e.source
      LEFT JOIN main.fingerprints target ON target.node = e.target
      WHERE e.kind = (SELECT id FROM main.edge_kinds WHERE name = 'calls')
      AND ((source.node IS NOT NULL AND NOT EXISTS (SELECT 1 FROM main.fingerprint_neighbours
        WHERE node = e.source AND neighbour = e.target))
      OR (target.node IS NOT NULL AND NOT EXISTS (SELECT 1 FROM main.fingerprint_neighbours
        WHERE node = e.target AND neighbour = e.source)))`,
    "invalid callback site": "SELECT 1 FROM main.edges WHERE (detail_kind = 5 AND argument IS NULL) OR (site_file IS NOT NULL AND detail_kind IS NOT 5)",
    "invalid or oversized node text": `SELECT 1 FROM main.nodes WHERE length(CAST(name AS BLOB)) > 65536
      OR length(CAST(qualified_name AS BLOB)) > 65536 OR length(CAST(signature AS BLOB)) > 65536
      OR length(CAST(docstring AS BLOB)) > 65536 OR length(CAST(return_type AS BLOB)) > 65536`,
    "invalid or oversized edge evidence": `SELECT 1 FROM main.edges WHERE length(CAST(target_name AS BLOB)) > 65536
      OR length(CAST(detail AS BLOB)) > 65536`,
    "invalid or oversized unresolved name": "SELECT 1 FROM main.unresolved_names WHERE length(CAST(name AS BLOB)) > 65536",
    "invalid or oversized node attributes": `SELECT 1 FROM main.node_attributes GROUP BY node, kind
      HAVING sum(length(CAST(value AS BLOB)) + 1) > 65536`,
    "invalid or oversized diagnostic": "SELECT 1 FROM main.file_diagnostics WHERE length(CAST(code AS BLOB)) > 4096",
    "invalid or oversized grounding baseline": `SELECT 1 FROM main._mex_grounded_source
      WHERE length(CAST(subject_id AS BLOB)) > 4096 OR length(CAST(node_kind AS BLOB)) > 64
        OR length(CAST(source AS BLOB)) > 4194304 OR length(CAST(fingerprint AS BLOB)) > 4194304`,
    "oversized coverage observation": `SELECT 1 WHERE
      (SELECT count(*) FROM main.coverage_directories) > 4096
      OR (SELECT sum(length(CAST(path AS BLOB)) + length(CAST(stamp AS BLOB))) FROM main.coverage_directories) > 524288
      OR (SELECT count(*) FROM main.coverage_extensions) > 64`,
  };
  for (const table of ["languages", "node_kinds", "edge_kinds", "provenances", "resolution_methods", "unresolved_reasons"]) {
    checks[`invalid ${table} code`] = `SELECT 1 FROM main.${table} WHERE length(CAST(name AS BLOB)) NOT BETWEEN 1 AND 128`;
  }
  for (const [table, fts] of [["nodes", "nodes_fts"], ["source_chunks", "source_chunks_fts"]] as const) {
    checks[`missing ${fts} row`] = `SELECT 1 FROM main.${table} AS row LEFT JOIN main.${fts}_docsize AS fts USING(id) WHERE fts.id IS NULL`;
    checks[`orphan ${fts} row`] = `SELECT 1 FROM main.${fts}_docsize AS fts LEFT JOIN main.${table} AS row USING(id) WHERE row.id IS NULL`;
  }
  for (const [failure, sql] of Object.entries(checks)) {
    if (overlay && (failure.includes("neighbour") || failure.includes("kind") || failure === "call stored outside unresolved_calls")) continue;
    const query = schema === "base" ? sql.replaceAll("main.", "base.") : sql;
    if (db.prepare(`${query} LIMIT 1`).get()) failures.push(failure);
  }
  if (overlay) failures.push(...inspectV5OverlayInvariants(db));
  return failures;
}

/** A validated base can only acquire dangling references at its shadow boundary. */
function inspectV5OverlayInvariants(db: SqliteDatabase): string[] {
  const offset = 2 ** 40;
  const checks: Record<string, string> = {
    "overlay file without a shadow": `SELECT 1 FROM main.files f WHERE NOT EXISTS (SELECT 1 FROM main.shadow_files s WHERE s.path = f.path)`,
    "shadow without a file": `SELECT 1 FROM main.shadow_files s WHERE NOT EXISTS (SELECT 1 FROM main.files f WHERE f.path = s.path)
      AND NOT EXISTS (SELECT 1 FROM base.files f WHERE f.path = s.path)`,
    "invalid overlay file key": `SELECT 1 FROM main.files f LEFT JOIN base.files b ON b.path = f.path
      WHERE (b.id IS NULL AND f.id <= ${offset}) OR (b.id IS NOT NULL AND f.id <> b.id)`,
    "invalid overlay node key": `SELECT 1 FROM main.nodes n LEFT JOIN base.nodes b ON b.public_id = n.public_id
      WHERE (b.id IS NULL AND n.id <= ${offset}) OR (b.id IS NOT NULL AND (n.id <> b.id OR n.file <> b.file OR n.kind <> b.kind))`,
    "invalid overlay unresolved call kind": `SELECT 1 FROM main.unresolved_calls u JOIN temp.v5_edge_kinds k ON k.id = u.kind
      WHERE k.name NOT IN ('calls', 'instantiates')`,
    "call stored outside overlay unresolved_calls": `SELECT 1 FROM main.unresolved_other u JOIN temp.v5_edge_kinds k ON k.id = u.kind
      WHERE k.name IN ('calls', 'instantiates')`,
    "retained edge targets a removed node": `SELECT 1 FROM temp.v5_shadowed_nodes n
      CROSS JOIN base.edges e ON e.target = n.id
      WHERE NOT EXISTS (SELECT 1 FROM main.nodes r WHERE r.id = n.id)
        AND e.source NOT IN (SELECT id FROM temp.v5_shadowed_nodes)`,
    "retained candidate targets a removed node": `SELECT 1 FROM temp.v5_shadowed_nodes n
      CROSS JOIN base.unresolved_calls u ON u.candidate = n.id
      WHERE NOT EXISTS (SELECT 1 FROM main.nodes r WHERE r.id = n.id)
        AND u.source NOT IN (SELECT id FROM temp.v5_shadowed_nodes)`,
    "retained callback site in a removed file": `SELECT 1 FROM temp.v5_shadowed_files f
      CROSS JOIN base.edges e ON e.site_file = f.id
      WHERE NOT EXISTS (SELECT 1 FROM main.files r WHERE r.id = f.id)
        AND e.source NOT IN (SELECT id FROM temp.v5_shadowed_nodes)`,
    "retained fingerprint neighbour is removed": `SELECT 1 FROM temp.v5_shadowed_nodes n
      CROSS JOIN base.fingerprint_neighbours f ON f.neighbour = n.id
      WHERE NOT EXISTS (SELECT 1 FROM main.nodes r WHERE r.id = n.id)
        AND f.node NOT IN (SELECT id FROM temp.v5_shadowed_nodes)`,
    "changed fingerprint neighbourhood is inconsistent": overlayNeighbourCheck(),
  };
  for (const table of CODE_TABLES) {
    checks[`invalid overlay ${table} code`] = `SELECT 1 FROM main.${table} a WHERE a.id <= ${offset}
      OR EXISTS (SELECT 1 FROM base.${table} b WHERE b.id = a.id OR b.name = a.name)
      ${table === "unresolved_names" ? "" : "OR length(CAST(a.name AS BLOB)) NOT BETWEEN 1 AND 128"}`;
  }
  const logicalReferences = new Set([
    "edges:target", "edges:site_file", "unresolved_calls:candidate", "fingerprint_neighbours:neighbour", "aliases:node",
    ...Object.keys(OWNED_KEYS).flatMap(table => CODE_TABLES.map(code => `${table}:${code}`)),
    "aliases:node_kinds",
  ]);
  for (const table of [...Object.keys(OWNED_KEYS), "aliases"]) {
    const keys = db.prepare(`SELECT [from] AS owner, [table] AS target FROM pragma_foreign_key_list(?, 'main')`)
      .all(table) as Array<{ owner: string; target: string }>;
    for (const { owner, target } of keys) {
      const logical = logicalReferences.has(`${table}:${owner}`) || logicalReferences.has(`${table}:${target}`);
      checks[`dangling overlay ${table}.${owner}`] = `SELECT 1 FROM main.${table} row WHERE row.${owner} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${logical ? v5Rows(db, target) : `main.${target}`} parent WHERE parent.${target === "fingerprints" ? "node" : "id"} = row.${owner})`;
    }
  }
  return Object.entries(checks).flatMap(([failure, sql]) => db.prepare(`${sql} LIMIT 1`).get() ? [failure] : []);
}

function overlayNeighbourCheck(): string {
  const calls = (["main", "base"] as const).flatMap(schema => (["source", "target"] as const).map(side =>
    `SELECT t.node, e.${side === "source" ? "target" : "source"} FROM touched t
      CROSS JOIN ${schema}.edges e ON e.${side} = t.node WHERE e.kind = (SELECT id FROM call_kind)
      ${schema === "base" ? "AND e.source NOT IN (SELECT id FROM temp.v5_shadowed_nodes)" : ""}`,
  )).join(" UNION ");
  return `WITH call_kind(id) AS (SELECT id FROM temp.v5_edge_kinds WHERE name = 'calls'),
    old_calls AS MATERIALIZED (SELECT DISTINCT source, target FROM base.edges
      WHERE kind = (SELECT id FROM call_kind) AND source IN (SELECT id FROM temp.v5_shadowed_nodes)),
    new_calls AS MATERIALIZED (SELECT DISTINCT source, target FROM main.edges WHERE kind = (SELECT id FROM call_kind)),
    removed AS (SELECT * FROM old_calls EXCEPT SELECT * FROM new_calls),
    added AS (SELECT * FROM new_calls EXCEPT SELECT * FROM old_calls),
    touched AS MATERIALIZED (
      SELECT node FROM main.fingerprints
      UNION SELECT target FROM removed WHERE EXISTS (SELECT 1 FROM temp.v5_fingerprints f WHERE f.node = removed.target)
      UNION SELECT target FROM added WHERE EXISTS (SELECT 1 FROM temp.v5_fingerprints f WHERE f.node = added.target)
    ), expected(node, neighbour) AS MATERIALIZED (${calls}), stored AS MATERIALIZED (
      SELECT f.node, f.neighbour FROM touched t CROSS JOIN main.fingerprint_neighbours f ON f.node = t.node
      UNION ALL SELECT f.node, f.neighbour FROM touched t CROSS JOIN base.fingerprint_neighbours f ON f.node = t.node
        WHERE f.node NOT IN (SELECT id FROM temp.v5_shadowed_nodes)
    )
    SELECT 1 FROM (SELECT * FROM expected EXCEPT SELECT * FROM stored)
    UNION ALL SELECT 1 FROM (SELECT * FROM stored EXCEPT SELECT * FROM expected)`;
}

export function installV5GraphViews(db: SqliteDatabase, uncovered: readonly string[] = [], overlay = false): void {
  if (projected.has(db) && uncovered.length === 0) return;
  const readOnly = (db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only;
  if (readOnly) db.pragma("query_only = OFF");
  try {
    if (!projected.has(db)) {
      db.pragma("temp_store = MEMORY");
      if (overlay) installV5Union(db);
      db.exec(overlay ? VIEWS.replace(/\bmain\.(\w+)/g, (_, table: string) => v5Rows(db, table)) : VIEWS);
      projected.add(db);
    }
    if (uncovered.length > 0) {
      const insert = db.prepare("INSERT OR IGNORE INTO temp.graph_uncovered VALUES (?)");
      for (const path of uncovered) insert.run(path);
    }
  } finally {
    if (readOnly) db.pragma("query_only = ON");
  }
}

const VIEWS = `
CREATE TEMP TABLE graph_uncovered(path TEXT PRIMARY KEY) WITHOUT ROWID;

CREATE TEMP VIEW files AS
SELECT f.id AS file_key, f.path, lower(hex(f.content_hash)) AS content_hash,
       l.name AS language, f.size, f.modified_at, s.indexed_at,
       (SELECT count(*) FROM main.nodes n WHERE n.file = f.id) AS node_count,
       (SELECT json_group_array(json_object('type', code, 'startLine', start_line, 'endLine', end_line))
        FROM (SELECT code, start_line, end_line FROM main.file_diagnostics
              WHERE file = f.id ORDER BY position)) AS errors,
       CASE f.parse_status WHEN 0 THEN 'ok' WHEN 1 THEN 'partial' WHEN 2 THEN 'failed' END AS parse_status,
       f.error_count AS diagnostic_count, f.missing_count, f.error_coverage, f.extractor_version
FROM main.files f JOIN main.languages l ON l.id = f.language CROSS JOIN main.snapshot s
WHERE f.path NOT IN (SELECT path FROM temp.graph_uncovered);

CREATE TEMP VIEW nodes AS
SELECT n.id AS node_key, n.kind AS kind_key, n.file AS file_key,
       k.name || ':' || lower(hex(n.public_id)) AS id, k.name AS kind, n.name, n.qualified_name,
       pk.name || ':' || lower(hex(p.public_id)) AS container_id, NULL AS identity_key,
       f.path AS file_path, l.name AS language,
       n.start_line, n.end_line, n.start_col AS start_column, n.end_col AS end_column,
       n.docstring, n.signature, n.visibility, n.flags & 1 AS is_exported,
       (n.flags >> 1) & 1 AS is_async, (n.flags >> 2) & 1 AS is_static, (n.flags >> 3) & 1 AS is_abstract,
       (SELECT CASE WHEN count(*) > 0 THEN json_group_array(value) END
        FROM (SELECT value FROM main.node_attributes WHERE node = n.id AND kind = 0 ORDER BY position)) AS decorators,
       (SELECT CASE WHEN count(*) > 0 THEN json_group_array(value) END
        FROM (SELECT value FROM main.node_attributes WHERE node = n.id AND kind = 1 ORDER BY position)) AS type_parameters,
       n.return_type, CASE WHEN n.body_hash IS NOT NULL THEN lower(hex(n.body_hash)) END AS body_hash,
       s.indexed_at AS updated_at
FROM main.nodes n JOIN main.node_kinds k ON k.id = n.kind
JOIN main.files f ON f.id = n.file JOIN main.languages l ON l.id = f.language
LEFT JOIN main.nodes p ON p.id = n.parent LEFT JOIN main.node_kinds pk ON pk.id = p.kind
CROSS JOIN main.snapshot s
WHERE f.path NOT IN (SELECT path FROM temp.graph_uncovered);

CREATE TEMP VIEW edges AS
SELECT e.source AS source_key, e.target AS target_key, e.kind AS kind_key, e.sequence AS id,
       sk.name || ':' || lower(hex(sn.public_id)) AS source,
       tk.name || ':' || lower(hex(tn.public_id)) AS target,
       k.name AS kind, nullif(e.line, -1) AS line, nullif(e.col, -1) AS col,
       sf.path AS source_path, p.name AS provenance, e.confidence, m.name AS resolution_method,
       CASE WHEN e.target_name IS NOT NULL THEN
         json_object('targetName', e.target_name, 'targetQualifiedName', tn.qualified_name)
       END AS metadata,
       CASE e.detail_kind
         WHEN 1 THEN json_array(json_object('declarationRole', e.detail))
         WHEN 2 THEN json_array(json_object('resolvedFilePath', tf.path))
         WHEN 3 THEN json_array(json_object('heritage', k.name))
         WHEN 4 THEN json_array(json_object('expression', e.detail))
         WHEN 5 THEN json_array(json_object('argumentIndex', e.argument, 'callee', sn.qualified_name,
              'wiringSite', json_object('filePath', coalesce(site.path, sf.path), 'line', e.line, 'column', e.col)))
         WHEN 6 THEN CASE
           WHEN k.name = 'contains' THEN json_array(json_object(
             'wiringSite', json_object('filePath', sf.path, 'line', e.line)))
           WHEN e.detail IS NULL THEN json_array(json_object('resolver', m.name,
             'wiringSite', json_object('filePath', sf.path, 'line', e.line, 'column', e.col)))
           ELSE json_array(json_object('resolver', m.name, 'importBinding', e.detail,
             'wiringSite', json_object('filePath', sf.path, 'line', e.line, 'column', e.col)))
         END
         WHEN 7 THEN json_array(json_object('moduleSpecifier', e.detail))
         ELSE '[]'
       END AS evidence
FROM main.edges e JOIN main.edge_kinds k ON k.id = e.kind
JOIN main.provenances p ON p.id = e.provenance JOIN main.resolution_methods m ON m.id = e.method
JOIN main.nodes sn ON sn.id = e.source JOIN main.node_kinds sk ON sk.id = sn.kind
JOIN main.nodes tn ON tn.id = e.target JOIN main.node_kinds tk ON tk.id = tn.kind
JOIN main.files sf ON sf.id = sn.file JOIN main.files tf ON tf.id = tn.file
LEFT JOIN main.files site ON site.id = e.site_file
WHERE sf.path NOT IN (SELECT path FROM temp.graph_uncovered);

CREATE TEMP VIEW node_aliases AS
SELECT a.old_public_id AS alias_digest, k.name AS alias_kind, a.node AS node_key,
       k.name || ':' || lower(hex(a.old_public_id)) AS alias_id, n.id AS canonical_node_id,
       a.match_method, a.confidence
FROM main.aliases a JOIN main.node_kinds k ON k.id = a.old_kind JOIN temp.nodes n ON n.node_key = a.node;

CREATE TEMP VIEW source_chunks AS
SELECT c.id, f.path AS file_path, c.start_line, c.end_line, lower(hex(f.content_hash)) AS content_hash
FROM main.source_chunks c JOIN main.files f ON f.id = c.file
WHERE f.path NOT IN (SELECT path FROM temp.graph_uncovered);

CREATE TEMP VIEW unresolved_refs AS
WITH refs AS (
  SELECT id, source, coalesce(written_name, name) AS name, kind, reason, line, col, candidate, receiver FROM main.unresolved_calls
  UNION ALL
  SELECT -id, source, name, kind, reason, line, col, NULL, NULL FROM main.unresolved_other
)
SELECT r.id, r.candidate AS candidate_key, n.id AS from_node_id, names.name AS reference_name,
       kind.name AS reference_kind, r.line, r.col, n.file_path, n.language,
       receiver.name AS receiver, receiver.name AS qualifier, 'unresolved' AS status,
       candidate.id AS candidate_id, NULL AS target_id, NULL AS import_source, NULL AS ref_key,
       CASE WHEN candidate.id IS NOT NULL THEN json_array(candidate.id) END AS candidates,
       json_object('reason', reason.name) AS metadata,
       CASE WHEN n.language = 'python' AND n.kind <> 'route' THEN NULL ELSE 0 END AS confidence,
       CASE
         WHEN n.kind = 'route' AND kind.name = 'function_ref' THEN 'engine-framework'
         WHEN n.language IN ('python', 'rust', 'csharp') THEN 'engine-' || n.language
         ELSE 'engine-ecmascript'
       END AS resolver
FROM refs r JOIN temp.nodes n ON n.node_key = r.source JOIN main.unresolved_names names ON names.id = r.name
JOIN main.edge_kinds kind ON kind.id = r.kind JOIN main.unresolved_reasons reason ON reason.id = r.reason
LEFT JOIN main.unresolved_names receiver ON receiver.id = r.receiver
LEFT JOIN temp.nodes candidate ON candidate.node_key = r.candidate;

CREATE TEMP VIEW _mex_grounded_source AS
SELECT subject_kind, subject_id, node_kind || ':' || lower(hex(public_id)) AS node_id,
       source, lower(hex(body_hash)) AS body_hash, fingerprint,
       CASE WHEN subject_kind = 'scaffold' THEN subject_id END AS scaffold_file
FROM main._mex_grounded_source;

CREATE TEMP VIEW node_fingerprints AS
SELECT f.node AS ref, n.id AS node_id, f.minhash, f.token_count
FROM main.fingerprints f JOIN temp.nodes n ON n.node_key = f.node;

CREATE TEMP VIEW project_metadata AS
SELECT 'manifest_hash' AS key, lower(hex(manifest_hash)) AS value, indexed_at AS updated_at FROM main.snapshot
UNION ALL SELECT 'config_hash', lower(hex(config_hash)), indexed_at FROM main.snapshot
UNION ALL SELECT 'grammar_hash', lower(hex(grammar_hash)), indexed_at FROM main.snapshot
UNION ALL SELECT 'extractor_version', extractor_version, indexed_at FROM main.snapshot
UNION ALL SELECT 'resolver_version', resolver_version, indexed_at FROM main.snapshot
UNION ALL SELECT 'graph_snapshot_v1', json_object(
  'version', 1, 'indexedAt', strftime('%Y-%m-%dT%H:%M:%fZ', indexed_at / 1000.0, 'unixepoch'),
  'lastSuccessfulIndexAt', strftime('%Y-%m-%dT%H:%M:%fZ', indexed_at / 1000.0, 'unixepoch'),
  'indexedBranch', indexed_branch,
  'indexedHead', CASE WHEN indexed_head IS NOT NULL THEN lower(hex(indexed_head)) END,
  'schemaVersion', 5, 'extractorVersion', extractor_version,
  'resolverVersion', resolver_version, 'grammarHash', lower(hex(grammar_hash)), 'configHash', lower(hex(config_hash)),
  'manifestHash', lower(hex(manifest_hash)), 'sourceCorpusDigest', lower(hex(corpus_digest)),
  'sourceCount', source_count,
  'engineRuntime', coalesce((SELECT value FROM main.meta WHERE key = 'engine_runtime'), 'native'),
  'nativeEngineUnavailable', (SELECT value FROM main.meta WHERE key = 'native_engine_unavailable'),
  'parseHealth', json_object('total', source_count, 'ok', source_count - partial_count - failed_count,
                             'partial', partial_count, 'failed', failed_count)
), indexed_at FROM main.snapshot
UNION ALL SELECT 'unindexed_source_coverage', coalesce((
  SELECT json_object('version', 1, 'policy', lower(hex(policy)), 'histogram', json_object(
    'total', total, 'truncated', json(CASE truncated WHEN 1 THEN 'true' ELSE 'false' END),
    'entries', (SELECT json_group_array(json_object('extension', extension, 'files', files)) FROM (SELECT * FROM main.coverage_extensions ORDER BY files DESC, extension))),
    'directories', (SELECT json_group_array(json_object('path', path, 'stamp', stamp)) FROM main.coverage_directories))
  FROM main.coverage_summary
), 'null'), indexed_at FROM main.snapshot;
`;
