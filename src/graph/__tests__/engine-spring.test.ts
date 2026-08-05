import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import { openSqlite } from "../db/sqlite.js";

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-graph-spring-"));
  const sourceDir = join(root, "src", "main", "java", "com", "example");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(root, "pom.xml"),
    `<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>`,
  );
  writeFileSync(
    join(sourceDir, "SpringOrderService.java"),
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "spring-order-service.java"), "utf-8"),
  );
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GraphEngine Spring DI integration", () => {
  it("persists Spring dependency edges between beans", () => {
    const orderService = find("OrderService");
    const reportService = find("ReportService");
    const stripeGateway = find("StripePaymentGateway");
    const inventory = find("InventoryRepository");
    const beanMethod = engine.searchNodes("checkout").find((node) =>
      node.kind === "method" && node.decorators?.includes("Bean")
    );
    expect(beanMethod).toBeDefined();

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(edge(db, orderService.id, stripeGateway.id)).toMatchObject({
        kind: "references",
        provenance: "heuristic",
      });
      expect(edge(db, orderService.id, inventory.id)).toMatchObject({
        kind: "references",
        provenance: "heuristic",
      });
      expect(edge(db, reportService.id, inventory.id)).toMatchObject({
        kind: "references",
        provenance: "heuristic",
      });
      expect(edge(db, beanMethod!.id, stripeGateway.id)).toMatchObject({
        kind: "references",
        provenance: "heuristic",
      });
    } finally {
      db.close();
    }
  });
});

function find(name: string) {
  const hit = engine.searchNodes(name).find((node) => node.name === name);
  expect(hit, `expected node ${name}`).toBeDefined();
  return hit!;
}

function edge(db: ReturnType<typeof openSqlite>, source: string, target: string) {
  return db.prepare("SELECT kind, provenance FROM edges WHERE source = ? AND target = ?")
    .get(source, target);
}
