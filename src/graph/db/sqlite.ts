// ============================================================================
// mex code-graph — node:sqlite adapter  (A3)
// ============================================================================
//
// A thin wrapper over Node's built-in `node:sqlite` (`DatabaseSync`). node:sqlite
// is real SQLite compiled into Node (WAL + FTS5 + mmap, no native build step), so
// the only shims are the conveniences node:sqlite omits: a `.pragma()` helper and
// a `.transaction()` helper. Requires Node ≥ 22.5 (set in `package.json` engines).
//
// `node:sqlite` emits a one-time ExperimentalWarning on first use; we suppress
// that ONE warning (below) so the CLI stays clean, while leaving every other
// process warning untouched.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// --- Suppress only node:sqlite's ExperimentalWarning -------------------------
// Node warns once that `node:sqlite` is experimental. That is noise on a CLI the
// user runs deliberately; drop just this warning and delegate all others.
{
  const original = process.emitWarning.bind(process);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.emitWarning = ((warning: any, ...rest: any[]) => {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (typeof message === "string" && /SQLite is an experimental feature/i.test(message)) {
      return;
    }
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Params = any[];

/** A prepared statement (better-sqlite3-shaped subset we use). */
export interface SqliteStatement {
  run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
  get(...params: Params): unknown;
  all(...params: Params): unknown[];
  iterate(...params: Params): IterableIterator<unknown>;
  /**
   * Rows as arrays in column order. Large scans avoid building an object per
   * row where the runtime supports it; the statement is used for nothing else.
   */
  iterateArrays(...params: Params): IterableIterator<unknown[]>;
}

/** A SQLite database handle. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(statement: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly open: boolean;
}

class NodeSqliteAdapter implements SqliteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;

  constructor(dbPath: string, options: { readOnly?: boolean; immutable?: boolean } = {}) {
    const { DatabaseSync } = require("node:sqlite");
    const location = options.immutable
      ? `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`
      : dbPath;
    this.db = new DatabaseSync(location, { readOnly: options.readOnly === true });
  }

  get open(): boolean {
    return this.db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.db.prepare(sql);
    return {
      run(...params: Params) {
        const r = stmt.run(...params);
        return { changes: Number(r?.changes ?? 0), lastInsertRowid: r?.lastInsertRowid ?? 0 };
      },
      get: (...params: Params) => stmt.get(...params),
      all: (...params: Params) => stmt.all(...params),
      iterate: (...params: Params) => stmt.iterate(...params),
      iterateArrays: (...params: Params) => {
        if (typeof stmt.setReturnArrays === "function") {
          stmt.setReturnArrays(true);
          return stmt.iterate(...params);
        }
        return (function* () {
          for (const row of stmt.iterate(...params)) yield Object.values(row as object);
        })();
      },
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Apply a PRAGMA (write form, e.g. `foreign_keys = ON`). */
  pragma(statement: string): void {
    this.db.exec(`PRAGMA ${statement}`);
  }

  /** Run `fn` inside a BEGIN/COMMIT, rolling back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    // DatabaseSync.close() throws if already closed; make it idempotent.
    if (this.db.isOpen) this.db.close();
  }
}

/**
 * Open (creating if needed) a SQLite database backed by `node:sqlite`. Throws a
 * clear message if the built-in module is unavailable (Node < 22.5).
 */
export function openSqlite(
  dbPath: string,
  options: { readOnly?: boolean; immutable?: boolean } = {},
): SqliteDatabase {
  try {
    return new NodeSqliteAdapter(dbPath, options);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      "mex code-graph requires the built-in node:sqlite module (Node.js 22.5+).\n" +
        `Run mex on Node 22.5 or newer. Underlying error: ${msg}`,
    );
  }
}

/**
 * Probe for FTS5 support and fail fast with an actionable message if it's missing.
 *
 * `node:sqlite`'s bundled SQLite is not guaranteed to be built with FTS5 on every
 * Node build/version, even within the range `package.json`'s `engines` documents
 * as supported (issue #110). Without this check, the first FTS5 statement — in
 * the graph's `schema.sql` or the wiki index's schema — throws SQLite's raw
 * `no such module: fts5`, which reads like a mex bug rather than a Node/SQLite
 * build limitation. Create-and-drop a throwaway virtual table rather than
 * querying `pragma_module_list`, since that pragma is unavailable on some
 * `node:sqlite` builds too and FTS5 usage is what actually needs to work.
 *
 * FTS5 availability is a property of the SQLite build the running Node binary
 * embeds, not of any particular database file, so the probe runs against a
 * throwaway `:memory:` connection rather than any caller's real database.
 * Probing in place (an earlier version of this function took the caller's
 * `SqliteDatabase`) rewrote the on-disk graph on every successful open, which
 * broke a read-path non-mutation regression test in CI (PR #168 review).
 *
 * It lives beside {@link openSqlite} rather than in the graph's `database.ts`
 * because it describes the SQLite build, not the code graph — and because both
 * FTS5 consumers need it, while the wiki may only reach into this module.
 *
 * @param open Injected opener, for tests that need the probe to fail. Production
 *             callers always use the default.
 */
export function assertFts5Available(open: typeof openSqlite = openSqlite): void {
  const probe = open(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE __mex_fts5_probe USING fts5(x)");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/fts5/i.test(msg)) throw error; // a different problem; surface it unchanged
    throw new Error(
      `Your Node (${process.version}) has SQLite built without FTS5 support, which mex's code graph `
        + "and wiki index require. FTS5 is a compile-time option, so this is a property of the Node "
        + "build rather than the version number - installing a different build or version of Node is "
        + "the fix. See the SQLite FTS5 section of COMPATIBILITY.md. "
        + `Underlying error: ${msg}`,
    );
  } finally {
    probe.close();
  }
}
