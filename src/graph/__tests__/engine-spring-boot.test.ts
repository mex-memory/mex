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
  "spring-boot-app",
);

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-spring-boot-graph-"));
  cpSync(FIXTURE, root, { recursive: true });
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Spring Boot 4 graph resolution", () => {
  it("activates resolver: route → handler and controller → service", () => {
    const route = engine
      .searchNodes("GET /api/widgets")
      .find((n) => n.kind === "route" && n.name === "GET /api/widgets");
    // Both WidgetService and WidgetController define list(); bind the controller handler.
    const list = engine
      .searchNodes("list")
      .find(
        (n) =>
          n.name === "list" &&
          n.kind === "method" &&
          n.filePath.endsWith("WidgetController.java"),
      );
    const controller = engine
      .searchNodes("WidgetController")
      .find((n) => n.name === "WidgetController" && n.kind === "class");
    const service = engine
      .searchNodes("WidgetService")
      .find((n) => n.name === "WidgetService" && n.kind === "class");

    expect(route).toBeDefined();
    expect(list).toBeDefined();
    expect(controller).toBeDefined();
    expect(service).toBeDefined();

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'references'",
          )
          .get(route!.id, list!.id),
      ).toMatchObject({ count: 1 });

      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'references'",
          )
          .get(controller!.id, service!.id),
      ).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });
});
