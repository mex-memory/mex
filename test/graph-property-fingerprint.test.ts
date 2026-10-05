/**
 * Class properties and fields get a body hash and a fingerprint, so a fact
 * about a property (its default, its visibility) can be grounded like a fact
 * about a method.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { openGraphDatabase } from "../src/graph/db/database.js";
import { FingerprintStore } from "../src/graph/fingerprint-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("property fingerprints", () => {
  it("hashes and fingerprints a TypeScript class property", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-property-fingerprint-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), [
      "export class App {",
      "  private _basePath: string = '/'",
      "  #routes: string[] = []",
      "  route(path: string): void {",
      "    this.#routes.push(this._basePath + path)",
      "  }",
      "}",
      "",
    ].join("\n"));
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const properties = ["_basePath", "#routes"].map((name) => {
      const found = engine.searchNodes(name.replace("#", "")).find((node) => node.name === name && (node.kind === "property" || node.kind === "field"));
      expect(found, name).toBeDefined();
      return engine.getNode(found!.id)!;
    });
    engine.close();

    const db = openGraphDatabase(join(root, ".mex", "graph.db"));
    try {
      const store = new FingerprintStore(db);
      for (const node of properties) {
        expect(node.bodyHash, node.name).toMatch(/^[0-9a-f]{64}$/);
        expect(store.get(node.id), node.name).not.toBeNull();
      }
    } finally {
      db.close();
    }
  });
});
