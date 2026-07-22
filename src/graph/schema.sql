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
VALUES (1, strftime('%s', 'now') * 1000, 'Initial mex code-graph schema (CG base + node.body_hash + fingerprints + grounded source)');

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
    errors TEXT               -- JSON array
);

-- Unresolved references: parked during single-file extraction, resolved after a
-- full index pass (two-phase extract -> resolve). Kept so cross-file edges work.
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT,          -- JSON array
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
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

-- Edge indexes. Narrow source-only / target-only indexes are intentionally
-- omitted; the (source, kind) / (target, kind) composites cover them via
-- SQLite's left-prefix scan.
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);

CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);

CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);

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
CREATE TABLE IF NOT EXISTS node_fingerprints (
    node_id      TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    minhash      TEXT NOT NULL,   -- JSON array of K=64 uint32 (spec §4: K)
    neighbors    TEXT NOT NULL,   -- JSON array of caller+callee Tier-1 ids (sorted)
    token_count  INTEGER NOT NULL -- < ~MIN_TOKENS (30) => don't trust the fingerprint
);

-- LSH banding index over `node_fingerprints.minhash`. Each fingerprint is split
-- into BANDS=32 bands of ROWS=2 rows; `LSH_lookup` fetches candidate node ids
-- that share a band hash with the query fingerprint (spec §4 step 2).
CREATE TABLE IF NOT EXISTS lsh_buckets (
    band      INTEGER NOT NULL,   -- 0..BANDS-1 (0..31)
    band_hash TEXT NOT NULL,
    node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lsh ON lsh_buckets(band, band_hash);

-- =============================================================================
-- Grounding baseline  (NET-NEW — spec §3, §5, §6.  ours.)
-- =============================================================================
--
-- Per grounded (scaffold_file, node) pair: the node's source, body_hash and
-- fingerprint AS OF the last time the scaffold was grounded/re-grounded. This
-- snapshot is what "old source" means at drift time — it lets the grounding
-- checker and `sync` hand the agent an old-vs-new diff without the pre-edit
-- file content (which is gone after save).
--
-- Keyed by `scaffold_file` (not the demo's `unit_id`): grounding is authored in
-- frontmatter (`grounds_to`), so a scaffold markdown file is the grounding unit.
CREATE TABLE IF NOT EXISTS _mex_grounded_source (
    scaffold_file TEXT NOT NULL,
    node_id       TEXT NOT NULL,
    source        TEXT NOT NULL,   -- node body as of last grounding (old side of the diff)
    body_hash     TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    PRIMARY KEY (scaffold_file, node_id)
);

-- Reverse lookup: which scaffold files ground to a given node (drives `mex
-- impact` and the grounding checker's per-node resolution).
CREATE INDEX IF NOT EXISTS idx_grounded_node ON _mex_grounded_source(node_id);
