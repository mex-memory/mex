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
  "java-package",
);

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-java-graph-"));
  cpSync(FIXTURE, join(root, "src"), { recursive: true });
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Java graph resolution", () => {
  it("binds package imports, calls, and instantiations", () => {
    const build = engine.searchNodes("build").find((n) => n.name === "build")!;
    const widget = engine.searchNodes("Widget").find((n) => n.name === "Widget")!;
    const touch = engine.searchNodes("touch").find((n) => n.name === "touch")!;
    expect(build).toBeDefined();
    expect(widget).toBeDefined();
    expect(touch).toBeDefined();

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      const importTargets = db
        .prepare(
          "SELECT target FROM edges WHERE source = ? AND kind = 'imports' ORDER BY target",
        )
        .all("file:src/com/example/service/Builder.java") as Array<{ target: string }>;
      expect(importTargets.map((row) => row.target)).toEqual([
        "file:src/com/example/models/Widget.java",
      ]);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'instantiates'",
          )
          .get(build.id, widget.id),
      ).toMatchObject({ count: 1 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'calls'",
          )
          .get(build.id, touch.id),
      ).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });
});
