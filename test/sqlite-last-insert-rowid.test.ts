// Regression coverage for issue #320: a DELETE from an FTS5 `contentless_delete`
// table (the graph's `source_chunks_fts`) writes a tombstone page whose shadow-table
// rowid is above 2^53, and SQLite reports it as the connection's last insert rowid.
// Node 26's `node:sqlite` throws ERR_OUT_OF_RANGE converting that to a JS number in
// `StatementSync.run()`, which aborted `mex graph refresh`; Node 22/24 silently lost
// precision instead. The adapter must neither throw nor round.

import { afterEach, describe, expect, it } from "vitest";
import { openSqlite, type SqliteDatabase } from "../src/graph/db/sqlite.js";

describe("node:sqlite adapter run() with a last insert rowid above 2^53", () => {
  let db: SqliteDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function contentlessDeleteTable(): SqliteDatabase {
    const opened = openSqlite(":memory:");
    opened.exec("CREATE VIRTUAL TABLE chunks USING fts5(body, content='', contentless_delete=1)");
    const insert = opened.prepare("INSERT INTO chunks(rowid, body) VALUES (?, ?)");
    for (let rowid = 1; rowid <= 50; rowid += 1) insert.run(rowid, `alpha beta ${rowid}`);
    return opened;
  }

  it("deletes from an FTS5 contentless_delete table repeatedly without throwing", () => {
    db = contentlessDeleteTable();
    const remove = db.prepare("DELETE FROM chunks WHERE rowid = ?");
    for (const rowid of [7, 8, 9]) {
      expect(() => remove.run(rowid)).not.toThrow();
    }
    const left = db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number };
    expect(left.n).toBe(47);
  });

  it("returns an unsafe last insert rowid as an exact bigint and a safe one as a number", () => {
    db = contentlessDeleteTable();
    const remove = db.prepare("DELETE FROM chunks WHERE rowid = ?");
    remove.run(7);
    const { lastInsertRowid, changes } = remove.run(8);
    expect(typeof changes).toBe("number");
    expect(typeof lastInsertRowid).toBe("bigint");
    expect(lastInsertRowid as bigint).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const insert = db.prepare("INSERT INTO chunks(rowid, body) VALUES (?, ?)");
    expect(insert.run(51, "gamma").lastInsertRowid).toBe(51);
  });

  it("leaves row reads on the same statement as numbers", () => {
    db = openSqlite(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
    const upsert = db.prepare("INSERT INTO t (id, n) VALUES (?, ?) RETURNING n");
    upsert.run(1, 5);
    expect(upsert.get(2, 6)).toEqual({ n: 6 });
  });
});
