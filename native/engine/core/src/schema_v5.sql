-- Engine-owned graph rows. All inter-row references use integer keys.
PRAGMA user_version = 5;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE languages          (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE node_kinds         (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE edge_kinds         (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE provenances        (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE resolution_methods (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE unresolved_reasons (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE unresolved_names   (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;

CREATE TABLE files (
    id                INTEGER PRIMARY KEY,
    path              TEXT NOT NULL UNIQUE,
    content_hash      BLOB NOT NULL CHECK(length(content_hash) = 32),
    language          INTEGER NOT NULL REFERENCES languages(id),
    size              INTEGER NOT NULL CHECK(size >= 0),
    modified_at       REAL    NOT NULL,
    parse_status      INTEGER NOT NULL CHECK(parse_status BETWEEN 0 AND 2), -- ok, partial, failed
    error_count       INTEGER NOT NULL CHECK(error_count >= 0),
    missing_count     INTEGER NOT NULL CHECK(missing_count >= 0),
    error_coverage    REAL NOT NULL CHECK(error_coverage BETWEEN 0 AND 1),
    extractor_version TEXT NOT NULL
) STRICT;

CREATE TABLE file_diagnostics (
    file       INTEGER NOT NULL REFERENCES files(id),
    position   INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),
    code       TEXT NOT NULL,
    start_line INTEGER NOT NULL CHECK(start_line > 0),
    end_line   INTEGER NOT NULL CHECK(end_line >= start_line),
    PRIMARY KEY (file, position)
) STRICT, WITHOUT ROWID;

CREATE TABLE nodes (
    id             INTEGER PRIMARY KEY,
    public_id      BLOB NOT NULL UNIQUE CHECK(length(public_id) = 16),
    kind           INTEGER NOT NULL REFERENCES node_kinds(id),
    file           INTEGER NOT NULL REFERENCES files(id),
    parent         INTEGER REFERENCES nodes(id),
    name           TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    start_line     INTEGER NOT NULL CHECK(start_line > 0),
    start_col      INTEGER NOT NULL CHECK(start_col >= 0),
    end_line       INTEGER NOT NULL CHECK(end_line >= start_line),
    end_col        INTEGER NOT NULL CHECK(end_col >= 0),
    signature      TEXT,
    flags          INTEGER NOT NULL CHECK(flags BETWEEN 0 AND 31), -- exported, async, static, abstract, default
    body_hash      BLOB CHECK(length(body_hash) = 32),
    docstring      TEXT,
    visibility     TEXT,
    return_type    TEXT
) STRICT;

-- kind: 0 decorator, 1 type parameter. Position preserves declaration order.
CREATE TABLE node_attributes (
    node     INTEGER NOT NULL REFERENCES nodes(id),
    kind     INTEGER NOT NULL CHECK(kind IN (0, 1)),
    position INTEGER NOT NULL CHECK(position >= 0),
    value    TEXT NOT NULL,
    PRIMARY KEY (node, kind, position)
) STRICT, WITHOUT ROWID;

-- line/col use -1 for no location so the primary key matches v4 call-site identity.
-- Evidence codes: 1 declaration role, 2 imported file, 3 heritage, 4 expression,
-- 5 callback wiring, 6 framework wiring (optional import binding), 7 syntax
-- import specifier. target_name is the written name; the qualified name comes
-- from the target row.
CREATE TABLE edges (
    source      INTEGER NOT NULL REFERENCES nodes(id),
    kind        INTEGER NOT NULL REFERENCES edge_kinds(id),
    target      INTEGER NOT NULL REFERENCES nodes(id),
    line        INTEGER NOT NULL CHECK(line = -1 OR line > 0),
    col         INTEGER NOT NULL CHECK(col >= -1),
    site_file   INTEGER REFERENCES files(id),
    provenance  INTEGER NOT NULL REFERENCES provenances(id),
    confidence  REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
    method      INTEGER NOT NULL REFERENCES resolution_methods(id),
    target_name TEXT,
    detail_kind INTEGER CHECK(detail_kind BETWEEN 1 AND 7),
    detail      TEXT,
    argument    INTEGER CHECK(argument >= 0),
    sequence    INTEGER NOT NULL CHECK(sequence > 0),
    PRIMARY KEY (source, kind, target, line, col)
) STRICT, WITHOUT ROWID;

CREATE TABLE unresolved_calls (
    id        INTEGER PRIMARY KEY,
    source    INTEGER NOT NULL REFERENCES nodes(id),
    name      INTEGER NOT NULL REFERENCES unresolved_names(id),
    kind      INTEGER NOT NULL REFERENCES edge_kinds(id),
    reason    INTEGER NOT NULL REFERENCES unresolved_reasons(id),
    line      INTEGER NOT NULL CHECK(line > 0),
    col       INTEGER NOT NULL CHECK(col >= 0),
    candidate INTEGER REFERENCES nodes(id),
    receiver  INTEGER REFERENCES unresolved_names(id),
    written_name INTEGER REFERENCES unresolved_names(id) -- only if the legacy display spelling differs
) STRICT;

-- The existing exact-name fallback also reports unresolved imports and bases.
CREATE TABLE unresolved_other (
    id     INTEGER PRIMARY KEY,
    source INTEGER NOT NULL REFERENCES nodes(id),
    name   INTEGER NOT NULL REFERENCES unresolved_names(id),
    kind   INTEGER NOT NULL REFERENCES edge_kinds(id),
    reason INTEGER NOT NULL REFERENCES unresolved_reasons(id),
    line   INTEGER NOT NULL CHECK(line > 0),
    col    INTEGER NOT NULL CHECK(col >= 0)
) STRICT;

CREATE TABLE fingerprints (
    node        INTEGER PRIMARY KEY REFERENCES nodes(id),
    minhash     BLOB NOT NULL CHECK(length(minhash) = 256), -- 64 big-endian u32 values
    token_count INTEGER NOT NULL CHECK(token_count >= 0)
) STRICT;

CREATE TABLE fingerprint_neighbours (
    node      INTEGER NOT NULL REFERENCES fingerprints(node),
    neighbour INTEGER NOT NULL REFERENCES nodes(id),
    PRIMARY KEY (node, neighbour)
) STRICT, WITHOUT ROWID;

CREATE TABLE aliases (
    old_public_id  BLOB PRIMARY KEY CHECK(length(old_public_id) = 16),
    old_kind       INTEGER NOT NULL REFERENCES node_kinds(id),
    node           INTEGER NOT NULL REFERENCES nodes(id),
    match_method   TEXT NOT NULL,
    confidence     REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1)
) STRICT, WITHOUT ROWID;

-- Historical baseline IDs can outlive both a node and its alias.
CREATE TABLE _mex_grounded_source (
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('scaffold', 'entity')),
    subject_id   TEXT NOT NULL,
    node_kind    TEXT NOT NULL,
    public_id    BLOB NOT NULL CHECK(length(public_id) = 16),
    source       TEXT NOT NULL,
    body_hash    BLOB NOT NULL CHECK(length(body_hash) = 32),
    fingerprint  TEXT NOT NULL,
    PRIMARY KEY (subject_kind, subject_id, public_id)
) STRICT, WITHOUT ROWID;

-- Contentless FTS indexes. The source itself is read from the proven checkout.
-- Keep the id column in the node tokenizer for v4's document lengths and rank.
CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, qualified_name, docstring, signature, content='');
CREATE TABLE source_chunks (
    id         INTEGER PRIMARY KEY,
    file       INTEGER NOT NULL REFERENCES files(id),
    start_line INTEGER NOT NULL CHECK(start_line > 0),
    end_line   INTEGER NOT NULL CHECK(end_line >= start_line)
) STRICT;
CREATE VIRTUAL TABLE source_chunks_fts USING fts5(path_terms, identifier_terms, comment_terms, source_text, content='');

CREATE TABLE snapshot (
    id               INTEGER PRIMARY KEY CHECK(id = 1),
    indexed_at       INTEGER NOT NULL CHECK(indexed_at >= 0),
    indexed_branch   TEXT,
    indexed_head     BLOB CHECK(length(indexed_head) IN (20, 32)),
    compiler_version TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    resolver_version TEXT NOT NULL,
    grammar_hash     BLOB NOT NULL CHECK(length(grammar_hash) = 32),
    config_hash      BLOB NOT NULL CHECK(length(config_hash) = 32),
    manifest_hash    BLOB NOT NULL CHECK(length(manifest_hash) = 32),
    corpus_digest    BLOB NOT NULL CHECK(length(corpus_digest) = 32),
    source_count     INTEGER NOT NULL CHECK(source_count >= 0),
    partial_count    INTEGER NOT NULL CHECK(partial_count >= 0),
    failed_count     INTEGER NOT NULL CHECK(failed_count >= 0),
    CHECK(partial_count + failed_count <= source_count)
) STRICT;

CREATE TABLE coverage (path TEXT PRIMARY KEY, reason TEXT NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE coverage_summary (
    id        INTEGER PRIMARY KEY CHECK(id = 1),
    policy    BLOB NOT NULL CHECK(length(policy) = 32),
    total     INTEGER NOT NULL CHECK(total >= 0),
    truncated INTEGER NOT NULL CHECK(truncated IN (0, 1))
) STRICT;
CREATE TABLE coverage_extensions (
    extension TEXT PRIMARY KEY,
    files     INTEGER NOT NULL CHECK(files > 0)
) STRICT, WITHOUT ROWID;
CREATE TABLE coverage_directories (path TEXT PRIMARY KEY, stamp TEXT NOT NULL) STRICT, WITHOUT ROWID;
