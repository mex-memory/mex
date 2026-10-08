/**
 * Opening the index — and refusing to fix it.
 *
 * **HARD: a read never rebuilds.** A missing, corrupt or version-mismatched
 * index returns a typed diagnostic and nothing else. The temptation is obvious
 * — the caller wanted an answer, a rebuild would produce one — and it is a trap
 * twice over: it turns a 10 ms query into a 5 s one at an unpredictable moment,
 * and it hides the fact that the index was broken, so nobody ever learns *why*
 * it keeps being broken. The layering lint keeps `src/wiki/query/` from even
 * importing the rebuild path, so this cannot be undone by a later convenience.
 *
 * Nor is the version check copied from the graph. `openReadOnlyGraphDatabase`
 * demands exact version equality and throws from inside the open, and
 * `database.ts:80` dispatches migrations through a single `if` where a ladder
 * belongs. Both are recorded for P4. This is new code, so it returns a result
 * rather than throwing, and a mismatch names both versions.
 */

import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { assertFts5Available, openSqlite, type SqliteDatabase } from "../../graph/db/sqlite.js";
import { fts5UnavailableDiagnostic } from "./fts5.js";
import { indexExists } from "./dbfile.js";
import { WIKI_META_KEYS, WIKI_SCHEMA_SQL, WIKI_SCHEMA_VERSION } from "./schema.js";

export interface WikiIndexHandle {
  readonly db: SqliteDatabase;
  /** Absolute path to the database file. */
  readonly path: string;
  readonly schemaVersion: number;
  close(): void;
}

export type OpenIndexResult =
  | { ok: true; index: WikiIndexHandle }
  | { ok: false; diagnostic: WikiDiagnostic };

export interface OpenIndexOptions {
  /**
   * Defaults to true. Query paths take the default; only the rebuild and
   * refresh paths open writable, and they say so.
   */
  readOnly?: boolean;
}

function handle(db: SqliteDatabase, path: string, schemaVersion: number): WikiIndexHandle {
  return { db, path, schemaVersion, close: () => db.close() };
}

/** Read `wiki_meta.schema_version`, or null when the table is absent or empty. */
function readSchemaVersion(db: SqliteDatabase): number | null {
  try {
    const row = db.prepare(`SELECT value FROM wiki_meta WHERE key = ?`).get(WIKI_META_KEYS.schemaVersion) as
      | { value?: unknown }
      | undefined;
    const raw = row?.value;
    if (typeof raw !== "string") return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    // No wiki_meta table, or the file is not a database at all. Both are
    // "unusable", and the remedy is the same one.
    return null;
  }
}

/**
 * Open an existing index for reading.
 *
 * Never creates, never migrates, never rebuilds.
 */
/**
 * Per-connection settings every wiki-index connection needs.
 *
 * **`busy_timeout` first, before any pragma that touches the file.** Under WAL
 * a second connection that finds the database locked fails immediately with
 * `SQLITE_BUSY` rather than waiting, so two `mex wiki` processes over one
 * scaffold — a rebuild while an editor's language server reads, an apply while
 * a refresh is in flight — turn a moment's contention into a hard error the
 * user sees. Five seconds is the graph's own figure (`src/graph/db/database.ts`
 * sets exactly this, with the same comment about ordering) and one number for
 * both databases is worth more than a second opinion.
 *
 * This is a fix rather than a tidy-up: the wiki index has had WAL since P3 and
 * has never had a busy timeout, so every concurrent access has been racing.
 */
function configureConnection(db: SqliteDatabase): void {
  db.pragma("busy_timeout = 5000");
}

export function openWikiIndex(path: string, options: OpenIndexOptions = {}): OpenIndexResult {
  if (!indexExists(path)) {
    return {
      ok: false,
      diagnostic: diagnostic("WIKI_INDEX_MISSING", `No wiki index at ${path}.`, { file: path }),
    };
  }

  const fts5 = fts5UnavailableDiagnostic(path);
  if (fts5) return { ok: false, diagnostic: fts5 };

  let db: SqliteDatabase;
  try {
    const readOnly = options.readOnly !== false;
    // Immutable read-only mode is both a consistency boundary and a
    // nonmutation guarantee: a normal SQLite read of a WAL database may create
    // `-wal`/`-shm`, which would make an ordinary query block the next explicit
    // refresh/rebuild. Writers always opt out explicitly.
    db = openSqlite(path, { readOnly, ...(readOnly ? { immutable: true } : {}) });
    configureConnection(db);
  } catch (error) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "WIKI_INDEX_REBUILD_REQUIRED",
        `The wiki index at ${path} could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        { file: path },
      ),
    };
  }

  const version = readSchemaVersion(db);
  if (version === null) {
    db.close();
    return {
      ok: false,
      diagnostic: diagnostic(
        "WIKI_INDEX_REBUILD_REQUIRED",
        `The wiki index at ${path} is not readable as a wiki index — its metadata table is missing or unreadable.`,
        { file: path },
      ),
    };
  }
  if (version !== WIKI_SCHEMA_VERSION) {
    db.close();
    return {
      ok: false,
      diagnostic: diagnostic(
        "WIKI_INDEX_REBUILD_REQUIRED",
        `The wiki index at ${path} was built by schema version ${version}; this build expects ${WIKI_SCHEMA_VERSION}.`,
        { file: path },
      ),
    };
  }

  return { ok: true, index: handle(db, path, version) };
}

/**
 * Create a brand-new index at `path`, applying the schema.
 *
 * Only the rebuild path calls this, and only against a temp file it is about to
 * publish. `foreign_keys` is on so that deleting a `wiki_files` row takes its
 * entities — and their relations, topics, sources and groundings — with it,
 * which is what makes refresh's per-file replacement a single statement rather
 * than seven that could drift apart.
 */
export function createWikiIndex(path: string): WikiIndexHandle {
  // Fail before the file is created, so a Node without FTS5 leaves no partial
  // index behind for the next run to trip over.
  assertFts5Available();
  const db = openSqlite(path);
  configureConnection(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    // The private candidate needs one durable schema commit, rather than a
    // separate WAL sync for every table and index declaration.
    db.transaction(() => {
      db.exec(WIKI_SCHEMA_SQL);
      db.prepare(`INSERT INTO wiki_meta (key, value) VALUES (?, ?)`).run(
        WIKI_META_KEYS.schemaVersion,
        String(WIKI_SCHEMA_VERSION),
      );
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return handle(db, path, WIKI_SCHEMA_VERSION);
}

/**
 * Open an existing index for writing, for the refresh path.
 *
 * Same refusals as {@link openWikiIndex}: a refresh against a stale-schema
 * index is a rebuild, and the caller has to say so.
 */
export function openWikiIndexForWrite(path: string): OpenIndexResult {
  const result = openWikiIndex(path, { readOnly: false });
  if (result.ok) result.index.db.pragma("foreign_keys = ON");
  return result;
}
