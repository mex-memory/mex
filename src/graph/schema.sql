-- ============================================================================
-- mex — Code-Graph SQLite schema  (FROZEN DATA CONTRACT — Phase 0, spec §3)
-- ============================================================================
--
-- This is the data contract the two Phase-1 tracks build against and must NOT
-- change under them:
--   * Track A (graph engine)  WRITES nodes / edges / files / unresolved_refs,
--                             maintains nodes_fts, computes body_hash.
--   * Track B (fingerprint /  WRITES node_fingerprints / lsh_buckets and reads
--     reconcile / grounding)  _mex_grounded_source; reconciles on Tier-1 miss.
--
-- Base = CodeGraph's schema (ported verbatim from `.demo/engine/schema.sql`)
-- for nodes / edges / files / unresolved_refs / nodes_fts (FTS5), taken as-is
-- except one delta carried over from the demo:
--   * `body_hash` column on `nodes` — the drift-detector trigger (demo A4).
--
-- Three tables are NET-NEW for mex 0.7.0 (spec §3), all at the bottom:
--   * node_fingerprints  — Tier-2 identity (MinHash + neighborhood signature).
--   * lsh_buckets        — LSH index over the fingerprints, for reconciliation.
--   * _mex_grounded_source — per-(scaffold_file, node) grounding baseline.
--
-- The demo keyed its grounding snapshot by `unit_id` (a `units` DB row). mex has
-- no `units` table: grounding lives in scaffold frontmatter (`grounds_to`), so
-- `_mex_grounded_source` is keyed by `scaffold_file` instead. This is the one
-- real demo→OSS adaptation (spec §3). The demo's `units` table is intentionally
-- NOT ported.
--
-- Connection-level PRAGMAs (WAL, foreign_keys=ON, busy_timeout, synchronous)
-- are applied in code at open time by the DB adapter (Track A, ported from
-- `.demo/engine/cg/src/db/`). journal_mode=WAL persists into the db file
-- header; foreign_keys is per-connection and MUST be re-asserted on every open
-- (the per-file replace path relies on ON DELETE CASCADE).
-- ============================================================================

-- Schema version tracking.
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
VALUES (4, strftime('%s', 'now') * 1000, 'Compact fingerprint/LSH storage with subject-generalized grounding');

-- =============================================================================
-- Core tables (ported from CodeGraph — kept as-is except node.body_hash)
-- =============================================================================

-- Nodes: code symbols (functions, classes, methods, ...).
--
-- IDENTITY (Tier 1, spec §1): the engine computes a LINE-INDEPENDENT id
--   nodes.id = `${kind}:` + sha256(`${file_path}:${kind}:${name}`).substring(0,32)
-- (ported verbatim from `.demo/engine/cg/src/extraction/tree-sitter-helpers.ts`).
-- The schema treats `id` as an opaque TEXT PK; callers MUST treat a node id as
-- stable across body edits and line shifts. Rename/move is handled by Tier-2
-- fingerprint reconciliation (node_fingerprints + lsh_buckets), not by the id.
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    container_id TEXT,
    identity_key TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    docstring TEXT,
    signature TEXT,
    visibility TEXT,
    is_exported INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    is_static INTEGER DEFAULT 0,
    is_abstract INTEGER DEFAULT 0,
    decorators TEXT,          -- JSON array
    type_parameters TEXT,     -- JSON array
    return_type TEXT,         -- normalized return/result type name
    -- body_hash (DELTA — NOT in stock CG): sha256 of the node's normalized
    -- source body, captured at extraction. The drift detector compares the
    -- stored hash against the freshly-extracted one: because `id` is
    -- line-independent, a node whose id is unchanged but whose body_hash MOVED
    -- is a real edit -> drift. Nullable so non-body kinds (imports, parameters)
    -- need not populate it.
    body_hash TEXT,
    updated_at INTEGER NOT NULL
);

-- Edges: relationships between nodes (calls, imports, extends, ...).
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata TEXT,            -- JSON object
    line INTEGER,
    col INTEGER,
    provenance TEXT DEFAULT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    resolution_method TEXT,
    evidence TEXT,
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Files: tracked source files. (size, modified_at, content_hash) drive the
-- two-stage "which files changed" filter that scopes incremental re-extraction.
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT,              -- JSON array
    parse_status TEXT NOT NULL DEFAULT 'ok' CHECK(parse_status IN ('ok','partial','failed')),
    diagnostic_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    error_coverage REAL NOT NULL DEFAULT 0,
    extractor_version TEXT NOT NULL DEFAULT 'unknown'
);

-- Unresolved references: parked during single-file extraction, then resolved
-- after a full index pass (two-phase extract -> resolve).
--
-- Only references the resolver could NOT bind are stored. A bound reference
-- becomes an edge, and every row this table used to keep with status
-- 'resolved' duplicated one — measured at 100% on every repository, and 27-73%
-- of the table. `edges` is a superset (it also holds structural `contains`
-- edges with no reference row), so nothing is recoverable from here that is
-- not already there.
--
-- What remains is the graph being honest about its own blind spots: a name
-- some file referenced that the resolver could not decide the meaning of. That
-- is what `mex graph query who-calls` falls back to when a name has call sites
-- but no indexed declaration.
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_key TEXT NOT NULL UNIQUE,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT,          -- JSON array
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    receiver TEXT,
    qualifier TEXT,
    import_source TEXT,
    metadata TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','ambiguous','unresolved')),
    target_id TEXT,
    confidence REAL,
    resolver TEXT,
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Compiler/fallback import binding evidence. This is deliberately separate
-- from graph edges: an import may be valid even when its target is outside the
-- indexed corpus.
CREATE TABLE IF NOT EXISTS import_bindings (
    binding_key TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    local_name TEXT NOT NULL,
    imported_name TEXT NOT NULL,
    module_specifier TEXT NOT NULL,
    resolved_file_path TEXT,
    target_id TEXT,
    is_type_only INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE SET NULL
);

-- Compatibility aliases survive rebuilds. Readers accept alias ids, while all
-- discovery APIs emit only the canonical node id.
CREATE TABLE IF NOT EXISTS node_aliases (
    alias_id TEXT PRIMARY KEY,
    canonical_node_id TEXT NOT NULL,
    match_method TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (canonical_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Source retrieval is indexed in overlapping windows. The FTS table is
-- contentless: response source is always re-read from disk.
CREATE TABLE IF NOT EXISTS source_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    path_terms TEXT NOT NULL,
    identifier_terms TEXT NOT NULL,
    comment_terms TEXT NOT NULL,
    UNIQUE(file_path, start_line, end_line)
);

CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
    path_terms,
    identifier_terms,
    comment_terms,
    source_text,
    content='',
    contentless_delete=1
);

-- =============================================================================
-- Full-text search (ported from CG — feeds searchNodes / scope selection)
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id,
    name,
    qualified_name,
    docstring,
    signature,
    content='nodes',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

-- =============================================================================
-- Indexes (ported from CG)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_identity_key ON nodes(identity_key);
CREATE INDEX IF NOT EXISTS idx_nodes_container_id ON nodes(container_id);

-- Edge indexes. Narrow source-only / target-only indexes are intentionally
-- omitted; the (source, kind) / (target, kind) composites cover them via
-- SQLite's left-prefix scan.
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
CREATE INDEX IF NOT EXISTS idx_edges_confidence ON edges(confidence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_semantic_callsite
ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));

CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);

-- A narrow (from_node_id) index is intentionally omitted: it is a strict
-- prefix of the composite below, which SQLite uses for every lookup the narrow
-- one served, the ON DELETE CASCADE probe included. Verified with EXPLAIN
-- QUERY PLAN on a real store; no plan degrades to a scan.
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);
-- Partial: a resolved reference is an edge and is not stored here. The
-- predicate keeps the index honest if a legacy store still carries such rows.
CREATE INDEX IF NOT EXISTS idx_unresolved_status
ON unresolved_refs(status) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_import_bindings_file ON import_bindings(file_path);
CREATE INDEX IF NOT EXISTS idx_import_bindings_local ON import_bindings(file_path, local_name);
CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON node_aliases(canonical_node_id);
CREATE INDEX IF NOT EXISTS idx_source_chunks_file ON source_chunks(file_path, start_line);

-- Incremental publication (issue #209): one digest per file over every derived
-- row that file owns (its nodes, the edges and unresolved references leaving
-- them, its import bindings, their fingerprints and its source chunks). A
-- refresh rewrites only the files whose digest changed. The digests are valid
-- only for the snapshot recorded beside them in project_metadata; any other
-- writer invalidates them and the next refresh publishes in full.
CREATE TABLE IF NOT EXISTS file_row_digests (
    path TEXT PRIMARY KEY,
    digest TEXT NOT NULL
) WITHOUT ROWID;

-- =============================================================================
-- Project metadata (ported from CG — small key/value store for build metadata,
-- e.g. last-build timestamp, extraction version).
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- =============================================================================
-- Fingerprint layer  (NET-NEW — spec §3, §4.  Tier-2 identity.)
-- =============================================================================
--
-- Written by Track B during `mex graph` (populated alongside node extraction).
-- Read by the reconciler on a Tier-1 miss to decide MOVED / GONE / AMBIGUOUS.

-- Per-node fingerprint: a MinHash sketch of the node's normalized-AST trigrams
-- plus its caller/callee neighborhood. Survives rename/move (which the
-- line-independent id does NOT), enabling reconciliation.
-- Schema v4 retains main-v3's compact re-encode (issue #140 storage
-- follow-up): the v2 encoding stored
-- the minhash as a JSON text array (~600 B where 256 B of BLOB suffice) and
-- 32 LSH rows per node each repeating the full TEXT node id and a 64-char hex
-- band hash, doubled again by idx_lsh — together ~40-50% of every graph store.
-- main-v3 and v4 store the sketch as a 256-byte big-endian BLOB, key LSH rows by a
-- stable INTEGER ref, truncates band hashes to their first 8 bytes as int64
-- (collisions merely add an LSH candidate, which full minhash scoring then
-- rejects), and makes the primary key serve as the only index. The decoded
-- Fingerprint values and every reconciler outcome are unchanged.
CREATE TABLE IF NOT EXISTS node_fingerprints (
    ref          INTEGER PRIMARY KEY, -- rowid alias: stable under VACUUM
    node_id      TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
    minhash      BLOB NOT NULL,  -- K=64 uint32 values, big-endian (spec §4: K)
    neighbors    TEXT NOT NULL,  -- JSON array of caller+callee Tier-1 ids (sorted)
    token_count  INTEGER NOT NULL -- < ~MIN_TOKENS (30) => don't trust the fingerprint
);

-- LSH banding index over `node_fingerprints.minhash`. Each fingerprint is split
-- into BANDS=32 bands of ROWS=2 rows; `LSH_lookup` fetches candidate node ids
-- that share a band hash with the query fingerprint (spec §4 step 2). The
-- composite primary key IS the lookup index — no secondary index needed.
CREATE TABLE IF NOT EXISTS lsh_buckets (
    band      INTEGER NOT NULL,  -- 0..BANDS-1 (0..31)
    band_hash INTEGER NOT NULL,  -- first 8 bytes of the band's sha256, as int64
    ref       INTEGER NOT NULL REFERENCES node_fingerprints(ref) ON DELETE CASCADE,
    PRIMARY KEY (band, band_hash, ref)
) WITHOUT ROWID;

-- =============================================================================
-- Grounding baseline  (NET-NEW — spec §3, §5, §6.  ours.)
-- =============================================================================
--
-- Per grounded (subject, node) pair: the node's source, body_hash and
-- fingerprint AS OF the last time that subject was grounded/re-grounded. This
-- snapshot is what "old source" means at drift time — it lets the grounding
-- checker and `sync` hand the agent an old-vs-new diff without the pre-edit
-- file content (which is gone after save).
--
-- SCHEMA v4 RETAINS INTEGRATION-v3'S GENERALIZED SUBJECT KEY.
--
-- v2 keyed this by `scaffold_file`, because grounding was authored in scaffold
-- frontmatter and a markdown file was therefore the grounding unit. The wiki
-- engine grounds an *entity*, and several entities live in one file, so a
-- file-keyed baseline cannot hold them apart. `subject_kind` says what
-- `subject_id` is: 'scaffold' for a scaffold markdown path, 'entity' for a
-- wiki entity id.
--
-- THIS REMAINS THE ONLY BASELINE STORE. The wiki index caches derived
-- resolution and health, which is disposable; it does not hold a second copy
-- of source, body_hash or fingerprint. Two stores of the same fact updated by
-- different code paths will disagree, and then neither is trustworthy.
--
-- `scaffold_file` survives as a GENERATED column projecting the scaffold-kind
-- rows, so every query written against the v2 shape keeps returning exactly
-- what it returned before, and NULL for the rows it was never meant to see. It
-- is read-only: writers use `subject_kind` + `subject_id`.
CREATE TABLE IF NOT EXISTS _mex_grounded_source (
    subject_kind  TEXT NOT NULL DEFAULT 'scaffold',  -- 'scaffold' | 'entity'
    subject_id    TEXT NOT NULL,                     -- scaffold path, or mx_… entity id
    node_id       TEXT NOT NULL,
    source        TEXT NOT NULL,   -- node body as of last grounding (old side of the diff)
    body_hash     TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    scaffold_file TEXT GENERATED ALWAYS AS (
        CASE WHEN subject_kind = 'scaffold' THEN subject_id END
    ) VIRTUAL,
    PRIMARY KEY (subject_kind, subject_id, node_id)
);

-- Reverse lookup: which subjects ground to a given node (drives `mex impact`,
-- the grounding checker's per-node resolution, and the wiki's code→knowledge
-- join).
CREATE INDEX IF NOT EXISTS idx_grounded_node ON _mex_grounded_source(node_id);

-- Forward lookup: every node one subject grounds to.
CREATE INDEX IF NOT EXISTS idx_grounded_subject ON _mex_grounded_source(subject_kind, subject_id);
