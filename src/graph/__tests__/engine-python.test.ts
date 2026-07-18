import { cpSync, mkdtempSync, rmSync } from "node:fs";
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
      const importTargets = db.prepare(
        "SELECT target FROM edges WHERE source = ? AND kind = 'imports' ORDER BY target",
      ).all("file:pkg/service.py") as Array<{ target: string }>;
      expect(importTargets.map((row) => row.target)).toEqual([
        "file:pkg/__init__.py",
        "file:pkg/models.py",
      ]);
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'calls'",
      ).get(build.id, exported.id)).toMatchObject({ count: 1 });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'instantiates'",
      ).get(build.id, widget.id)).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });
});
