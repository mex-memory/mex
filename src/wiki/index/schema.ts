/**
 * The disposable index's schema.
 *
 * **Inlined as a string constant rather than shipped as a `.sql` asset.**
 * `src/graph/assets.ts` exists because `schema.sql` has to be located at
 * runtime relative to `import.meta.url`, works in a dev checkout, and then does
 * not exist in `dist/` unless a build script copies it — its own header calls
 * that "the #1 way a tree-sitter CLI ships broken". A string constant cannot
 * fail to be packaged: it is compiled into the bundle by the same step that
 * compiles the code that uses it, so there is no resolution to get wrong and no
 * copy step to forget. The cost is that the SQL is not greppable as a `.sql`
 * file; `WIKI_TABLES` below keeps it enumerable, and a test asserts the schema
 * declares exactly those tables.
 *
 * Everything here is **derived**. No fact lives only in this database: delete
 * `wiki.db` and a rebuild from Markdown reproduces every row. That is the
 * property the determinism test enforces, and the reason there is no column for
 * anything a user could type.
 *
 * Offsets are UTF-16 code-unit indices into decoded text, exactly as the codec
 * produced them (D2a). They are stored, never recomputed, and never derived
 * from a `Buffer` length.
 */

/**
 * Bumped whenever a stored column changes meaning or disappears.
 *
 * A mismatch is a typed `WIKI_INDEX_REBUILD_REQUIRED` diagnostic from
 * `openWikiIndex`, never a throw from inside an open and never a silent
 * rebuild on a read path.
 */
export const WIKI_SCHEMA_VERSION = 4;

/** Every table the schema declares, for the packaging and dump tests. */
export const WIKI_TABLES = [
  "wiki_diagnostics",
  "wiki_entities",
  "wiki_entity_topics",
  "wiki_files",
  "wiki_fts",
  "wiki_groundings",
  "wiki_meta",
  "wiki_relations",
  "wiki_sources",
] as const;

export type WikiTable = (typeof WIKI_TABLES)[number];

/** Keys written into `wiki_meta`. */
export const WIKI_META_KEYS = {
  schemaVersion: "schema_version",
  builtAt: "built_at",
  buildKind: "build_kind",
  scaffoldRoot: "scaffold_root",
  fileCount: "file_count",
  entityCount: "entity_count",
  indexedRevision: "indexed_revision",
} as const;

export const WIKI_SCHEMA_SQL = `
-- Rebuild metadata and the schema version. Read before anything else.
CREATE TABLE wiki_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per indexed Markdown file. \`path\` is scaffold-relative and POSIX,
-- always: a backslash in this column is a determinism failure the first time
-- the same scaffold is indexed on Linux.
CREATE TABLE wiki_files (
  path          TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  parse_status  TEXT NOT NULL CHECK (parse_status IN ('ok', 'diagnostics')),
  entity_count  INTEGER NOT NULL,
  text_length   INTEGER NOT NULL,
  -- Wall clock, and therefore the one column a clean rebuild and an
  -- incremental refresh can never agree on. Excluded from the normalized dump
  -- by name, with that reason recorded there.
  indexed_at    TEXT NOT NULL
);

-- Entities, with the exact source location P5 needs to compute a patch plan.
-- Every offset column is UTF-16 code units into the decoded file text.
--
-- **The primary key is the location, not the id.** An entity id is supposed to
-- be unique and usually is, but DUPLICATE_ENTITY_ID is a required diagnostic
-- (§14.4) and a duplicate is normally two files that were copied from one
-- another — so the index has to be able to *hold* both claimants in order to
-- report them. Keying on the id instead would make the second insert fail, and
-- the honest report would degrade into whichever claimant happened to be
-- written first. \`entity_key\` is \`<file>#<zero-padded metadata_start>\`, which
-- is derived from content, sorts in file-then-position order, and gives the
-- child tables something stable to hang from.
--
-- \`shadowed\` marks every claimant of a contested id except the winner. Queries
-- by id filter on it; the global resolution pass recomputes it from the table,
-- so deleting the winner's file promotes the survivor with no reparse.
CREATE TABLE wiki_entities (
  entity_key          TEXT PRIMARY KEY,
  id                  TEXT NOT NULL,
  shadowed            INTEGER NOT NULL DEFAULT 0 CHECK (shadowed IN (0, 1)),
  file                TEXT NOT NULL REFERENCES wiki_files(path) ON DELETE CASCADE,
  type                TEXT NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  metadata_kind       TEXT NOT NULL CHECK (metadata_kind IN ('frontmatter', 'comment')),
  metadata_start      INTEGER NOT NULL,
  metadata_end        INTEGER NOT NULL,
  heading_start       INTEGER NOT NULL,
  heading_end         INTEGER NOT NULL,
  body_start          INTEGER NOT NULL,
  body_end            INTEGER NOT NULL,
  start_line          INTEGER NOT NULL,
  end_line            INTEGER NOT NULL,
  heading_depth       INTEGER NOT NULL,
  file_content_hash   TEXT NOT NULL,
  entity_content_hash TEXT NOT NULL,
  -- Canonical JSON, so the dump is stable and P5 can round-trip what it did not
  -- model as a column.
  provenance          TEXT,
  metadata            TEXT
);

CREATE INDEX wiki_entities_id     ON wiki_entities(id, shadowed);
CREATE INDEX wiki_entities_file   ON wiki_entities(file);
CREATE INDEX wiki_entities_status ON wiki_entities(status, type);
CREATE INDEX wiki_entities_title  ON wiki_entities(title);

-- Outgoing triples. \`ordinal\` is the position in the entity's own relation
-- list, which is what makes (source_key, ordinal) a natural key and the dump
-- order independent of insertion order.
--
-- \`target_resolved\` records whether the target existed at index time. A
-- dangling target is a diagnostic, never a deleted row: cascading it away is
-- how a broken reference becomes invisible.
CREATE TABLE wiki_relations (
  source_key      TEXT NOT NULL REFERENCES wiki_entities(entity_key) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  type            TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  target_resolved INTEGER NOT NULL CHECK (target_resolved IN (0, 1)),
  note            TEXT,
  metadata        TEXT,
  PRIMARY KEY (source_key, ordinal)
);

CREATE INDEX wiki_relations_target ON wiki_relations(target_id, type);

-- Topics are entities of type \`topic\` (§8.5), so this is a join and never a
-- topic store: a table holding topic rows would duplicate wiki_entities and the
-- two would drift. Title, description and aliases live on the topic's own row.
-- Aliases are resolved to ids before any write — an alias never reaches a row.
CREATE TABLE wiki_entity_topics (
  entity_key      TEXT NOT NULL REFERENCES wiki_entities(entity_key) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  topic_entity_id TEXT NOT NULL,
  PRIMARY KEY (entity_key, ordinal)
);

CREATE INDEX wiki_entity_topics_topic ON wiki_entity_topics(topic_entity_id);

CREATE TABLE wiki_sources (
  entity_key  TEXT NOT NULL REFERENCES wiki_entities(entity_key) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  type        TEXT NOT NULL,
  ref         TEXT,
  note        TEXT,
  repository  TEXT,
  commit_sha  TEXT,
  captured_at TEXT,
  -- \`sourceIdentity()\` from the model, so dedup uses one definition.
  identity    TEXT NOT NULL,
  metadata    TEXT,
  PRIMARY KEY (entity_key, ordinal)
);

-- A derived resolution cache only (D1). The canonical grounding lives in
-- Markdown; the one baseline store is \`graph.db._mex_grounded_source\`. Nothing
-- here is a source of truth: delete this database and a rebuild recovers the
-- reference from Markdown and the verdict from the graph.
--
-- \`node_id\`, \`fingerprint\` and \`body_hash\` are what Markdown committed.
-- \`body_hash\` is the one that detects drift: the fingerprint is a MinHash over
-- grammar kinds, so it is blind to a changed constant or a renamed local, which
-- is precisely the edit a decision entity is usually grounded to. It is
-- nullable because §8.7 requires only node and fingerprint, and a grounding
-- written without one can still be checked — just more coarsely.
--
-- \`state\`, \`resolved_node\` and \`health\` are the *derived* verdict, and all
-- three are NULL until something resolves them against a graph. NULL means "not
-- resolved here", which is honest; writing 'unverified' would look like a
-- verdict that had been reached. \`resolved_node\` differs from \`node_id\` exactly
-- when reconciliation rebound a moved symbol — the entity id never changes.
CREATE TABLE wiki_groundings (
  entity_key    TEXT NOT NULL REFERENCES wiki_entities(entity_key) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  node_id       TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  body_hash     TEXT,
  -- The committed comment-free code hash (#236), as Markdown spells it.
  code_hash     TEXT,
  file          TEXT,
  commit_sha    TEXT,
  verified_at   TEXT,
  reason        TEXT,
  state         TEXT,
  resolved_node TEXT,
  health        TEXT,
  -- Canonical JSON of the complete derived resolution. The scalar columns
  -- remain queryable; this preserves candidates/reasons and drift evidence for
  -- the application projection without inventing them on reads.
  resolution    TEXT,
  PRIMARY KEY (entity_key, ordinal)
);

CREATE INDEX wiki_groundings_node ON wiki_groundings(node_id);

-- Diagnostics, with the scope that decides their lifetime.
--
-- 'file' diagnostics belong to one file and die with its row. 'global' ones —
-- duplicate ids, dangling relation targets, unknown topics — are a property of
-- the whole set and are recomputed wholesale on every rebuild and refresh,
-- because a file that arrives can *resolve* one just as easily as a file that
-- leaves can create one.
CREATE TABLE wiki_diagnostics (
  scope        TEXT NOT NULL CHECK (scope IN ('file', 'global')),
  code         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  message      TEXT NOT NULL,
  file         TEXT,
  entity_id    TEXT,
  path         TEXT,
  start_offset INTEGER,
  end_offset   INTEGER,
  start_line   INTEGER,
  end_line     INTEGER,
  remediation  TEXT
);

CREATE INDEX wiki_diagnostics_scope ON wiki_diagnostics(scope, file);

-- Full text over title, summary, body, aliases and selected metadata (§10.2).
-- "Selected metadata" resolved to: entity type, the scaffold-relative file path,
-- and the titles of the entity's topics — the three things a user searches by
-- that are not prose. Everything else in \`metadata\` is structural and would
-- only add noise to the ranking.
CREATE VIRTUAL TABLE wiki_fts USING fts5(
  entity_key UNINDEXED,
  title,
  summary,
  body,
  aliases,
  meta,
  tokenize = 'unicode61'
);
`;
