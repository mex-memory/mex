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
  "hibernate-boot4-app",
);

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-hibernate-graph-"));
  cpSync(FIXTURE, root, { recursive: true });
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Hibernate 7 graph resolution", () => {
  it("links entity associations and repository to entity", () => {
    const order = engine
      .searchNodes("Order")
      .find((n) => n.name === "Order" && n.kind === "class");
    const widget = engine
      .searchNodes("Widget")
      .find((n) => n.name === "Widget" && n.kind === "class");
    const lineItem = engine
      .searchNodes("LineItem")
      .find((n) => n.name === "LineItem" && n.kind === "class");
    const repo = engine
      .searchNodes("OrderRepository")
      .find((n) => n.name === "OrderRepository" && n.kind === "interface");

    expect(order).toBeDefined();
    expect(widget).toBeDefined();
    expect(lineItem).toBeDefined();
    expect(repo).toBeDefined();

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'references'",
          )
          .get(order!.id, widget!.id),
      ).toMatchObject({ count: 1 });

      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'references'",
          )
          .get(lineItem!.id, order!.id),
      ).toMatchObject({ count: 1 });

      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM edges WHERE source = ? AND target = ? AND kind = 'references'",
          )
          .get(repo!.id, order!.id),
      ).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });
});
