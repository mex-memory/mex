import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "python-package",
);

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-python-graph-"));
  cpSync(FIXTURE, join(root, "pkg"), { recursive: true });
  writeFileSync(
    join(root, "pkg/alias_service.py"),
    "from . import exported as named_export\n\ndef alias_call():\n    return named_export()\n",
  );
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Python graph resolution", () => {
  it("binds relative package imports, calls, and instantiations", () => {
    const build = engine.searchNodes("build_widget").find((node) => node.name === "build_widget")!;
    const widget = engine.searchNodes("Widget").find((node) => node.name === "Widget")!;
    const exported = engine.searchNodes("exported").find((node) => node.name === "exported")!;
    expect(build).toBeDefined();
    expect(widget).toBeDefined();
    expect(exported).toBeDefined();

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      const serviceFile = db.prepare(
        "SELECT id FROM nodes WHERE kind = 'file' AND file_path = 'pkg/service.py'",
      ).get() as { id: string };
      const importTargets = db.prepare(
        `SELECT target.file_path FROM edges
         JOIN nodes target ON target.id = edges.target
         WHERE edges.source = ? AND edges.kind = 'imports' ORDER BY target.file_path`,
      ).all(serviceFile.id) as Array<{ file_path: string }>;
      expect(importTargets.map((row) => row.file_path)).toEqual([
        "pkg/__init__.py",
        "pkg/models.py",
      ]);
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'calls'",
      ).get(build.id, exported.id)).toMatchObject({ count: 1 });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'instantiates'",
      ).get(build.id, widget.id)).toMatchObject({ count: 1 });
      const aliasCall = engine.searchNodes("alias_call").find((node) => node.name === "alias_call")!;
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'calls'",
      ).get(aliasCall.id, exported.id)).toMatchObject({ count: 1 });
      expect(db.prepare(
        `SELECT local_name, imported_name, resolved_file_path, target_id FROM import_bindings
         WHERE file_path = 'pkg/alias_service.py' AND local_name = 'named_export'`,
      ).all()).toEqual(expect.arrayContaining([{
        local_name: "named_export",
        imported_name: "exported",
        resolved_file_path: "pkg/__init__.py",
        target_id: exported.id,
      }]));
    } finally {
      db.close();
    }
  });
});
