-- MEX graph schema v5 (OSS-73): written by the Rust engine.
--
-- Rules, each from a past bug (docs/design/graph-engine-baseline.md and the
-- engine design's lessons):
--   * rows reference each other by INTEGER key; a node's public id is stored
--     once, as the 16 bytes its 32-hex text form names;
--   * hashes are bytes, never hex text;
--   * kinds, edge kinds, languages, provenance and unresolved reasons are
--     small integers with a lookup table, never repeated text;
--   * no JSON columns, no stored identity key, no LSH table;
--   * unresolved calls are a per-file count by reason, not rows;
--   * secondary indexes are built after the bulk insert.

CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

-- Lookup tables: id -> name for every small-integer code below.
CREATE TABLE languages          (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE node_kinds         (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE edge_kinds         (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE provenances        (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE unresolved_reasons (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

CREATE TABLE files (
    id            INTEGER PRIMARY KEY,
    path          TEXT    NOT NULL UNIQUE,
    content_hash  BLOB    NOT NULL,           -- 32 bytes
    language      INTEGER NOT NULL REFERENCES languages(id),
    size          INTEGER NOT NULL,
    parse_status  INTEGER NOT NULL,           -- 0 ok, 1 partial, 2 failed
    error_count   INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    -- Digest of every row this file owns: refreshes rewrite only changed files.
    row_digest    BLOB
);

CREATE TABLE nodes (
    id             INTEGER PRIMARY KEY,
    public_id      BLOB    NOT NULL UNIQUE,   -- 16 bytes
    kind           INTEGER NOT NULL REFERENCES node_kinds(id),
    file           INTEGER NOT NULL REFERENCES files(id),
    parent         INTEGER,                   -- containing node
    name           TEXT    NOT NULL,
    qualified_name TEXT    NOT NULL,
    start_line     INTEGER NOT NULL,          -- 1-based, as today
    start_col      INTEGER NOT NULL,
    end_line       INTEGER NOT NULL,
    end_col        INTEGER NOT NULL,
    signature      TEXT,                      -- bounded
    flags          INTEGER NOT NULL DEFAULT 0, -- bit 0 exported, 1 async, 2 static, 3 abstract, 4 default export
    body_hash      BLOB,                      -- 32 bytes
    docstring      TEXT                       -- bounded
);

CREATE TABLE edges (
    source     INTEGER NOT NULL,
    kind       INTEGER NOT NULL,
    target     INTEGER NOT NULL,
    line       INTEGER NOT NULL DEFAULT 0,    -- 1-based call-site line; 0 when none
    col        INTEGER NOT NULL DEFAULT 0,    -- 0-based column of the called name
    provenance INTEGER NOT NULL,
    confidence REAL    NOT NULL DEFAULT 1,
    PRIMARY KEY (source, kind, target, line, col)
) WITHOUT ROWID;

CREATE TABLE unresolved (
    file   INTEGER NOT NULL,
    reason INTEGER NOT NULL,
    count  INTEGER NOT NULL,
    PRIMARY KEY (file, reason)
) WITHOUT ROWID;

CREATE TABLE fingerprints (
    node        INTEGER PRIMARY KEY,          -- nodes(id); only nodes with enough tokens
    minhash     BLOB    NOT NULL,             -- 64 x u32, big-endian
    neighbours  BLOB    NOT NULL,             -- packed 16-byte public ids, sorted
    token_count INTEGER NOT NULL
);

-- An old public id (an earlier engine's, or a renamed declaration's) that now
-- names a node, so grounded anchors keep resolving.
CREATE TABLE aliases (
    old_public_id BLOB PRIMARY KEY,
    node          INTEGER NOT NULL
) WITHOUT ROWID;

-- Files considered but not indexed, with the reason ("too big", "parse failed").
CREATE TABLE coverage (
    path   TEXT PRIMARY KEY,
    reason TEXT NOT NULL
) WITHOUT ROWID;
