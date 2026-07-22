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

  constructor(dbPath: string) {
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(dbPath);
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
export function openSqlite(dbPath: string): SqliteDatabase {
  try {
    return new NodeSqliteAdapter(dbPath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      "mex code-graph requires the built-in node:sqlite module (Node.js 22.5+).\n" +
        `Run mex on Node 22.5 or newer. Underlying error: ${msg}`,
    );
  }
}
