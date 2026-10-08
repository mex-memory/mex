/**
 * The normalized dump — the oracle for D5.
 *
 * Written **before** the refresh path, deliberately. A dump built afterwards
 * gets shaped, one small concession at a time, into something that agrees with
 * whatever refresh happens to produce: order by rowid, round the timestamp,
 * leave out the column that drifts. Each concession is individually reasonable
 * and the end state is a test that cannot fail. So this exists first, every
 * exclusion is named in {@link DUMP_EXCLUSIONS} with its reason, and the list is
 * short enough to read.
 *
 * The dump is part of the product, not test scaffolding: `mex wiki doctor` will
 * want exactly this, and so will anyone diffing two checkouts of one scaffold.
 *
 * Nothing here orders by rowid. Every table has a declared key and is sorted by
 * it, so two indexes holding the same rows produce the same bytes no matter
 * what order they were written in — which is the whole claim being tested.
 */

import type { SqliteDatabase } from "../../graph/db/sqlite.js";

/**
 * Something left out of the dump, and why it cannot be compared.
 *
 * `kind` matters: `wiki_meta`'s exclusions are *rows* — one key each — while
 * `wiki_files.indexed_at` is a column. Calling both "column" made the two
 * indistinguishable, which would make a column-coverage check expect three
 * columns on `wiki_meta` that do not exist.
 */
export interface DumpExclusion {
  table: string;
  /** A column name when `kind` is "column"; a `wiki_meta` key when it is "meta-key". */
  column: string;
  kind: "column" | "meta-key";
  reason: string;
}

/**
 * Every column the oracle does not check.
 *
 * Each entry is a hole in the oracle, so the list is kept short and stated in
 * the phase report rather than being quietly widened until the test goes green.
 */
export const DUMP_EXCLUSIONS: readonly DumpExclusion[] = [
  {
    table: "wiki_files",
    column: "indexed_at",
    kind: "column",
    reason:
      "Wall-clock time of the write. A clean rebuild and an incremental refresh of the same content can never agree on it, and no consumer treats it as content — it exists so `mex wiki doctor` can say how old a row is.",
  },
  {
    table: "wiki_meta",
    column: "built_at",
    kind: "meta-key",
    reason: "Wall clock, for the same reason as wiki_files.indexed_at.",
  },
  {
    table: "wiki_meta",
    column: "build_kind",
    kind: "meta-key",
    reason:
      "Records whether the index came from a rebuild or a refresh. Comparing it would make the determinism test assert the two paths are distinguishable, which is the opposite of the property under test.",
  },
  {
    table: "wiki_meta",
    column: "scaffold_root",
    kind: "meta-key",
    reason:
      "An absolute path, so it differs between two checkouts of the same scaffold and between a dev box and CI. Every path that is content is stored scaffold-relative elsewhere.",
  },
];

const EXCLUDED_META_KEYS = new Set(
  DUMP_EXCLUSIONS.filter((entry) => entry.kind === "meta-key").map((entry) => entry.column),
);

/**
 * Column lists, in dump order, with the exclusions already applied.
 *
 * Exported so a test can compare it against the schema the database actually
 * has. It is maintained by hand, and a hand-maintained mirror of a schema is a
 * hole in the oracle waiting for the next table: whatever is missing here is
 * simply not compared, and nothing fails.
 */
export const TABLE_COLUMNS: Record<string, { columns: string[]; orderBy: string }> = {
  wiki_meta: { columns: ["key", "value"], orderBy: "key" },
  wiki_files: {
    columns: ["path", "content_hash", "parse_status", "entity_count", "text_length"],
    orderBy: "path",
  },
  wiki_entities: {
    columns: [
      "entity_key",
      "id",
      "shadowed",
      "file",
      "type",
      "title",
      "summary",
      "body",
      "status",
      "revision",
      "metadata_kind",
      "metadata_start",
      "metadata_end",
      "heading_start",
      "heading_end",
      "body_start",
      "body_end",
      "start_line",
      "end_line",
      "heading_depth",
      "file_content_hash",
      "entity_content_hash",
      "provenance",
      "metadata",
    ],
    orderBy: "entity_key",
  },
  wiki_relations: {
    columns: ["source_key", "ordinal", "type", "target_id", "target_resolved", "note", "metadata"],
    orderBy: "source_key, ordinal",
  },
  wiki_entity_topics: {
    columns: ["entity_key", "ordinal", "topic_entity_id"],
    orderBy: "entity_key, ordinal",
  },
  wiki_sources: {
    columns: ["entity_key", "ordinal", "type", "ref", "note", "repository", "commit_sha", "captured_at", "identity", "metadata"],
    orderBy: "entity_key, ordinal",
  },
  wiki_groundings: {
    // Health, state and the resolved node are compared like everything else.
    // They are derived from the code graph rather than from Markdown, which
    // makes them the one place a dump can differ for a reason that is not a
    // refresh bug — so `resolveIndexState` recomputes all three from the same
    // resolver on both paths, and the determinism test hands both paths the
    // same one. Excluding them instead would put the phase's own new state
    // outside the oracle, which is the opposite of what the exclusion list is
    // for.
    columns: [
      "entity_key", "ordinal", "node_id", "fingerprint", "body_hash", "code_hash", "file", "commit_sha",
      "verified_at", "reason", "state", "resolved_node", "health", "resolution",
    ],
    orderBy: "entity_key, ordinal",
  },
  wiki_diagnostics: {
    // No natural key: a file can legitimately produce two identical-looking
    // diagnostics at different offsets. Ordered by every column instead, so the
    // ordering is total and cannot fall back to insertion order.
    columns: ["scope", "code", "severity", "file", "entity_id", "path", "start_offset", "end_offset", "start_line", "end_line", "message", "remediation"],
    orderBy: "scope, code, file, entity_id, path, start_offset, end_offset, start_line, end_line, message, remediation",
  },
  wiki_fts: {
    columns: ["entity_key", "title", "summary", "body", "aliases", "meta"],
    orderBy: "entity_key",
  },
};

/** Tables in dump order. */
export const DUMP_TABLES = Object.keys(TABLE_COLUMNS).sort();

/** Columns of `table` that the dump compares. */
export function dumpColumnsFor(table: string): readonly string[] {
  return TABLE_COLUMNS[table]?.columns ?? [];
}

/** Columns of `table` the dump deliberately skips. */
export function excludedColumnsFor(table: string): readonly string[] {
  return DUMP_EXCLUSIONS.filter((entry) => entry.table === table && entry.kind === "column").map(
    (entry) => entry.column,
  );
}

/**
 * A stable textual rendering of every row in the index.
 *
 * One line per row: the table name, then the row's values as a JSON array in
 * the declared column order. JSON because it distinguishes `null` from `""` and
 * `0` from `"0"` — a dump that renders them alike hides exactly the kind of
 * drift a refresh introduces.
 */
export function dumpWikiIndex(db: SqliteDatabase): string {
  const lines: string[] = [];

  for (const table of DUMP_TABLES) {
    const { columns, orderBy } = TABLE_COLUMNS[table]!;
    const rows = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`).all() as Record<
      string,
      unknown
    >[];

    for (const row of rows) {
      if (table === "wiki_meta" && EXCLUDED_META_KEYS.has(String(row["key"]))) continue;
      lines.push(`${table}\t${JSON.stringify(columns.map((column) => normalize(row[column])))}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * SQLite hands integers back as `number` or `bigint` depending on magnitude.
 * Normalizing keeps a row that round-tripped through two different code paths
 * from differing only in how JSON rendered the same value.
 */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value ?? null;
}
