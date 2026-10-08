/**
 * The write side: schema, open, publish, and what a rebuild actually stores.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSqlite } from "../../../graph/db/sqlite.js";
import { WIKI_META_KEYS, WIKI_SCHEMA_SQL, WIKI_SCHEMA_VERSION, WIKI_TABLES } from "../schema.js";
import { DUMP_EXCLUSIONS, DUMP_TABLES, dumpColumnsFor, excludedColumnsFor } from "../dump.js";
import { createWikiIndex, openWikiIndex } from "../open.js";
import { assertIndexPath, bindIndexDirectory, indexSiblingPaths, IndexPathError } from "../dbfile.js";
import { sweepPendingIndexes } from "../publish.js";
import { rebuildWikiIndex } from "../rebuild.js";
import { refreshWikiIndex } from "../refresh.js";
import { createScaffold, fixtureRoot, steppingClock, type Scaffold } from "./harness.js";

describe("schema", () => {
  it("declares exactly the tables it enumerates, and resolves without an asset lookup", () => {
    // The packaging test. The graph's schema.sql has to be found at runtime and
    // copied into dist/ by a build script; its own header calls a missing copy
    // "the #1 way a tree-sitter CLI ships broken". This schema is a string
    // constant, so the way a published install resolves it is the way this test
    // resolves it: by importing the module. What is asserted is that there is
    // nothing else to resolve.
    const source = WIKI_SCHEMA_SQL;
    expect(source).not.toContain("readFileSync");
    const declared = [...source.matchAll(/CREATE (?:VIRTUAL )?TABLE (\w+)/g)].map((match) => match[1]!).sort();
    expect(declared).toEqual([...WIKI_TABLES]);
  });

  it("is applied in full by createWikiIndex, tables and indexes alike", () => {
    const scaffold = createScaffold();
    try {
      const handle = createWikiIndex(join(scaffold.root, "wiki.db"));
      const names = (handle.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
        name: string;
      }[]).map((row) => row.name);
      for (const table of WIKI_TABLES) expect(names).toContain(table);
      expect(handle.schemaVersion).toBe(WIKI_SCHEMA_VERSION);
      handle.close();
    } finally {
      scaffold.dispose();
    }
  });
});

describe("the dump covers the schema", () => {
  it("compares every table the schema declares", () => {
    // DUMP_TABLES is maintained by hand, so a table added to the schema would
    // simply fall outside the oracle: nothing would compare it and nothing
    // would fail. Both sides are derived here rather than restated, so the next
    // table cannot be forgotten. P4 adds one (wiki_grounding_snapshots).
    const declared = [...WIKI_SCHEMA_SQL.matchAll(/CREATE (?:VIRTUAL )?TABLE (\w+)/g)].map((match) => match[1]!).sort();
    expect(DUMP_TABLES).toEqual(declared);
    expect(declared.length).toBeGreaterThan(5);
  });

  it("compares every column of every table, or names it as an exclusion", () => {
    // Column level, against the database the schema actually produces rather
    // than against the SQL text — a column added by a later ALTER, or one the
    // schema declares in a way the regex would miss, still has to be accounted
    // for.
    const scaffold = createScaffold();
    try {
      const handle = createWikiIndex(join(scaffold.root, "wiki.db"));
      try {
        for (const table of DUMP_TABLES) {
          const actual = (handle.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
            .map((row) => row.name)
            .sort();
          const accounted = [...dumpColumnsFor(table), ...excludedColumnsFor(table)].sort();
          expect(accounted, `${table}: every column must be dumped or explicitly excluded`).toEqual(actual);
        }
      } finally {
        handle.close();
      }
    } finally {
      scaffold.dispose();
    }
  });

  it("keeps the exclusion list short, and every entry justified", () => {
    // Each exclusion is a hole in the oracle. There is no principled maximum,
    // but there is a principled requirement: a reason, in prose, next to it.
    expect(DUMP_EXCLUSIONS.length).toBeLessThanOrEqual(6);
    for (const exclusion of DUMP_EXCLUSIONS) {
      expect(exclusion.reason.length, `${exclusion.table}.${exclusion.column} needs a reason`).toBeGreaterThan(40);
      expect(DUMP_TABLES).toContain(exclusion.table);
    }
  });
});

describe("opening the index", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  it("reports a missing index and does not create one", () => {
    scaffold = createScaffold();
    const path = join(scaffold.root, "wiki.db");
    const result = openWikiIndex(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("WIKI_INDEX_MISSING");
    // The refusal is the feature: a read that rebuilds turns a 10 ms query into
    // a 5 s one at random and hides that the index was broken.
    expect(existsSync(path)).toBe(false);
  });

  it("durably creates the complete schema and version together", () => {
    scaffold = createScaffold();
    const path = join(scaffold.root, "wiki.db");
    const created = createWikiIndex(path);
    expect(created.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    created.close();
    const result = openWikiIndex(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic.message);
    try {
      expect(result.index.schemaVersion).toBe(WIKI_SCHEMA_VERSION);
      for (const table of WIKI_TABLES) {
        expect(() => result.index.db.prepare(`SELECT * FROM ${table} LIMIT 0`).all()).not.toThrow();
      }
      expect(result.index.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { result.index.close(); }
  });

  it("reports a corrupt index rather than throwing", () => {
    scaffold = createScaffold();
    const path = join(scaffold.root, "wiki.db");
    writeFileSync(path, "SQLite format 3 this is not", "utf-8");
    const result = openWikiIndex(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("WIKI_INDEX_REBUILD_REQUIRED");
  });

  it("reports a version mismatch, naming both versions", () => {
    scaffold = createScaffold();
    const path = join(scaffold.root, "wiki.db");
    const handle = createWikiIndex(path);
    handle.db
      .prepare(`UPDATE wiki_meta SET value = ? WHERE key = ?`)
      .run(String(WIKI_SCHEMA_VERSION + 7), WIKI_META_KEYS.schemaVersion);
    handle.close();

    const result = openWikiIndex(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("WIKI_INDEX_REBUILD_REQUIRED");
      expect(result.diagnostic.message).toContain(String(WIKI_SCHEMA_VERSION + 7));
      expect(result.diagnostic.message).toContain(String(WIKI_SCHEMA_VERSION));
    }
  });

  it("refuses to refresh an index it would have to rebuild", () => {
    scaffold = createScaffold();
    scaffold.write("a.md", "# A\n");
    const result = refreshWikiIndex({
      scaffoldRoot: scaffold.root,
      indexPath: join(scaffold.root, "wiki.db"),
      changed: ["a.md"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("WIKI_INDEX_MISSING");
  });
});

describe("the database module's path guard", () => {
  it("accepts database files and their siblings, and nothing else", () => {
    expect(() => assertIndexPath("/x/wiki.db")).not.toThrow();
    expect(() => assertIndexPath("/x/wiki.db-wal")).not.toThrow();
    expect(() => assertIndexPath("/x/wiki.db.tmp-a1b2c3")).not.toThrow();
    expect(() => assertIndexPath("/x/ROUTER.md")).toThrow(IndexPathError);
    expect(() => assertIndexPath("/x/wiki.db.md")).toThrow(IndexPathError);
    expect(() => assertIndexPath("/x/notes")).toThrow(IndexPathError);
  });

  it("refuses to bind anything that is not a database", () => {
    expect(() => bindIndexDirectory("/x/ROUTER.md")).toThrow(IndexPathError);
  });
});

describe("atomic publish", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  it("leaves no temp files, no stale WAL siblings, and a readable index", () => {
    scaffold = createScaffold();
    scaffold.write("a.md", "# A\n\nProse.\n");
    const indexPath = join(scaffold.root, "wiki.db");

    rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });

    const leftovers = readdirSync(scaffold.root).filter((name) => name.startsWith("wiki.db"));
    expect(leftovers).toEqual(["wiki.db"]);

    const opened = openWikiIndex(indexPath);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.index.close();
  });

  it("replaces an existing index in place, and a reader sees the new content", () => {
    scaffold = createScaffold();
    scaffold.write("a.md", entityFile("mx_01KR2E4K002H3ZYA9G0C4XV531", "First"));
    const indexPath = join(scaffold.root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
    expect(titles(indexPath)).toEqual(["First"]);

    // A live sidecar may belong to an active reader/writer. Publication must
    // refuse it rather than deleting bytes it cannot prove are stale.
    writeFileSync(`${indexPath}-wal`, "stale write-ahead log", "utf-8");

    scaffold.write("a.md", entityFile("mx_01KR2E4K002H3ZYA9G0C4XV531", "Second"));
    const refused = rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
    expect(refused.diagnostics.map((entry) => entry.code)).toContain("WIKI_INDEX_REBUILD_REQUIRED");
    expect(titles(indexPath)).toEqual(["First"]);
    expect(readFileSync(`${indexPath}-wal`, "utf8")).toBe("stale write-ahead log");

    for (const sidecar of indexSiblingPaths(indexPath)) rmSync(sidecar, { force: true });
    rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
    expect(titles(indexPath)).toEqual(["Second"]);

    // No temp database survives. The `-wal`/`-shm` files that may exist here
    // are the reader's own: a read-only connection cannot delete them on close,
    // and they belong to the database that is actually there.
    const remaining = readdirSync(scaffold.root).filter((name) => name.startsWith("wiki.db"));
    expect(remaining.filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(remaining).toContain("wiki.db");
  });

  it("sweeps a temp database a crashed build left behind", () => {
    scaffold = createScaffold();
    const indexPath = join(scaffold.root, "wiki.db");
    const orphan = `${indexPath}.tmp-deadbeef`;
    openSqlite(orphan).close();
    expect(existsSync(orphan)).toBe(true);

    scaffold.write("a.md", "# A\n");
    const result = rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
    expect(result.sweptTempFiles).toEqual(["wiki.db.tmp-deadbeef"]);
    expect(existsSync(orphan)).toBe(false);
    // And the sweep is scoped by name: it never touches another database.
    expect(sweepPendingIndexes(
      join(scaffold.root, "other.db"),
      bindIndexDirectory(join(scaffold.root, "other.db"), scaffold.root),
    )).toEqual([]);
  });
});

describe("rebuilding the realistic scaffold", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  it("stores every entity, relation, topic, source and grounding the corpus declares", () => {
    scaffold = createScaffold();
    scaffold.copyFrom(fixtureRoot("scaffold"));
    const indexPath = join(scaffold.root, "wiki.db");
    const result = rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });

    // The corpus has eight entities across six of its eight files. Asserting
    // the number, not just "more than zero": P2b shipped two tests that passed
    // over an empty set for a full verification cycle.
    expect(result.fileCount).toBe(8);
    expect(result.entityCount).toBe(8);

    const opened = openWikiIndex(indexPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const { db } = opened.index;
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_entities`)).toBe(8);
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_entities WHERE shadowed = 1`)).toBe(0);
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_relations`)).toBeGreaterThan(0);
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_relations WHERE target_resolved = 0`)).toBe(0);
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_entity_topics`)).toBeGreaterThan(0);
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_sources`)).toBeGreaterThan(0);
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_groundings`)).toBeGreaterThan(0);
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_fts`)).toBe(8);

      // Grounding is stored, never resolved: health belongs to P4.
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_groundings WHERE health IS NOT NULL`)).toBe(0);

      // Paths are scaffold-relative POSIX.
      const files = (db.prepare(`SELECT DISTINCT file FROM wiki_entities ORDER BY file`).all() as { file: string }[]).map(
        (row) => row.file,
      );
      expect(files).toContain("context/architecture.md");
      expect(files.every((file) => !file.includes("\\"))).toBe(true);

      // Every stored offset is a real slice of the file it points into.
      const rows = db.prepare(`SELECT file, metadata_start, body_end, start_line FROM wiki_entities`).all() as {
        file: string;
        metadata_start: number;
        body_end: number;
        start_line: number;
      }[];
      for (const row of rows) {
        expect(row.metadata_start).toBeLessThan(row.body_end);
        expect(row.start_line).toBeGreaterThanOrEqual(1);
      }
    } finally {
      opened.index.close();
    }
  });

  it("reports duplicate ids across two files without losing either row", () => {
    scaffold = createScaffold();
    const id = "mx_01KRMEXM00JAAVJPQVVRX8N56V";
    scaffold.write("a.md", entityFile(id, "Claimant A"));
    scaffold.write("b.md", entityFile(id, "Claimant B"));
    const indexPath = join(scaffold.root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });

    const opened = openWikiIndex(indexPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const { db } = opened.index;
      // Both claimants are stored — reporting a duplicate requires holding both.
      expect(count(db, `SELECT COUNT(*) AS n FROM wiki_entities WHERE id = '${id}'`)).toBe(2);
      const shadowed = db
        .prepare(`SELECT file FROM wiki_entities WHERE shadowed = 1`)
        .all() as { file: string }[];
      expect(shadowed.map((row) => row.file)).toEqual(["b.md"]);
      const codes = (db.prepare(`SELECT code FROM wiki_diagnostics`).all() as { code: string }[]).map((row) => row.code);
      expect(codes).toContain("DUPLICATE_ENTITY_ID");
    } finally {
      opened.index.close();
    }
  });
});

describe("full-text indexing", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  it("keeps a file-level entity searchable by prose that follows a nested entity", () => {
    // §3c finding 23. A file-level entity's body stops at the first nested
    // entity and never resumes. Indexed naively, `epilogueterm` below belongs
    // to no entity at all and the file-level entity is unreachable through it —
    // a retrieval gap with no failing test unless this one exists.
    scaffold = createScaffold();
    scaffold.write(
      "architecture.md",
      `---
name: architecture
mex:
  id: mx_01KS6FPN00RT04JXY9QEG0JN19
  type: architecture
  status: promoted
  revision: 1
---

# Architecture

Prologueterm, before anything nested.

<!-- mex:entity
id: mx_01KSRGFP00P5TVKWJ2P5Z9DFJV
type: component
status: promoted
revision: 1
-->
## Gateway

Nestedterm, inside the nested entity.

## Epilogue

Epilogueterm, after the nested entity and back at depth two.
`,
    );

    const indexPath = join(scaffold.root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });

    const opened = openWikiIndex(indexPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const search = (term: string): string[] =>
        (
          opened.index.db
            .prepare(
              `SELECT e.id AS id FROM wiki_fts f JOIN wiki_entities e ON e.entity_key = f.entity_key
                WHERE wiki_fts MATCH ? ORDER BY e.id`,
            )
            .all(term) as { id: string }[]
        ).map((row) => row.id);

      const fileLevel = "mx_01KS6FPN00RT04JXY9QEG0JN19";
      const nested = "mx_01KSRGFP00P5TVKWJ2P5Z9DFJV";

      expect(search("prologueterm")).toEqual([fileLevel]);
      // The naive implementation fails exactly here.
      expect(search("epilogueterm")).toEqual([fileLevel]);
      // And the nested entity keeps its own prose, without it being copied up.
      expect(search("nestedterm")).toEqual([nested]);
    } finally {
      opened.index.close();
    }
  });
});

function entityFile(id: string, title: string): string {
  return `<!-- mex:entity\nid: ${id}\ntype: decision\nstatus: promoted\nrevision: 1\n-->\n## ${title}\n\nBody prose.\n`;
}

function titles(indexPath: string): string[] {
  const opened = openWikiIndex(indexPath);
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  try {
    return (opened.index.db.prepare(`SELECT title FROM wiki_entities ORDER BY title`).all() as { title: string }[]).map(
      (row) => row.title,
    );
  } finally {
    opened.index.close();
  }
}

function count(db: { prepare(sql: string): { get(): unknown } }, sql: string): number {
  const row = db.prepare(sql).get() as { n?: unknown };
  return Number(row?.n ?? 0);
}
