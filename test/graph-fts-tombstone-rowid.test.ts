// Regression coverage for #320: `mex graph refresh` aborted with "Value is too
// large to be represented as a JavaScript number: 9007336693694464" once a
// tracked source file changed.
//
// Deleting from a `contentless_delete=1` FTS5 table writes a tombstone page to
// the table's shadow `_data` table, and that page's id (65537 << 37) is left as
// the connection's last_insert_rowid. The delete's `run()` result reports it,
// and node:sqlite throws on some Node versions when it reads a value above
// Number.MAX_SAFE_INTEGER as a number.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { openSqlite } from "../src/graph/db/sqlite.js";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows file locks */ }
  }
});

describe("FTS5 tombstone rowids (#320)", () => {
  it("returns a delete's tombstone rowid above 2^53 as a bigint instead of a number", () => {
    const db = openSqlite(join(tempRoot("mex-320-adapter-"), "fts.db"));
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(body, content='', contentless_delete=1)");
      const insert = db.prepare("INSERT INTO t(rowid, body) VALUES (?, ?)");
      for (let i = 1; i <= 50; i++) insert.run(i, `hello ${i}`);

      const del = db.prepare("DELETE FROM t WHERE rowid = ?");
      del.run(1);
      const tombstone = del.run(2).lastInsertRowid;

      expect(typeof tombstone).toBe("bigint");
      expect(tombstone).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    } finally {
      db.close();
    }
  });

  it("keeps the other statement reads on plain numbers after a run()", () => {
    const db = openSqlite(join(tempRoot("mex-320-reads-"), "plain.db"));
    try {
      db.exec("CREATE TABLE n (id INTEGER PRIMARY KEY, v INTEGER)");
      const insert = db.prepare("INSERT INTO n(v) VALUES (?)");
      expect(insert.run(7).changes).toBe(1);
      expect(db.prepare("SELECT id, v FROM n").get()).toEqual({ id: 1, v: 7 });
      expect(db.prepare("SELECT id FROM n").all()).toEqual([{ id: 1 }]);
    } finally {
      db.close();
    }
  });

  it("re-indexes a changed source file when the stored chunks have to be deleted", async () => {
    const root = tempRoot("mex-320-sync-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".mex"), { recursive: true });
    const source = join(root, "src", "checkout.ts");
    // One file spanning many chunks: replacing it deletes them one by one, and a later
    // delete from the FTS5 table is the one that leaves the tombstone rowid.
    const body = (extra: number) =>
      Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i + extra};\n`).join("");
    writeFileSync(source, body(0));

    const engine = createGraphEngine({ rootDir: root });
    try {
      await engine.build();
      writeFileSync(source, body(1));
      const result = await engine.sync(["src/checkout.ts"]);
      expect(result.filesIndexed).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });
});
