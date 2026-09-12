import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildGraph } from "../maintenance.js";
import { openSqlite } from "../db/sqlite.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Flask resolver integration", () => {
  it("persists route nodes and resolved function_ref edges through a real build", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-flask-integration-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
    writeFileSync(join(root, "requirements.txt"), "flask>=3.0\n");
    writeFileSync(
      join(root, "src", "app.py"),
      [
        "from flask import Flask",
        "app = Flask(__name__)",
        "",
        "@app.route('/health', methods=['GET', 'POST'])",
        "async def health():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    );

    const result = await rebuildGraph(root);
    expect(result.status.status).toBe("fresh");

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      const routes = db.prepare(
        "SELECT id, name, signature FROM nodes WHERE kind = 'route' ORDER BY name",
      ).all() as Array<{ id: string; name: string; signature: string }>;
      expect(routes.map((route) => route.name)).toEqual(["GET /health", "POST /health"]);
      expect(routes[0]!.signature).toBe("GET /health -> health");

      const resolved = db.prepare(
        "SELECT e.target, n.name AS route_name FROM edges e JOIN nodes n ON n.id = e.source"
        + " WHERE e.kind = 'references' AND e.provenance = 'framework' AND e.resolution_method = 'flask-route-handler'",
      ).all() as Array<{ target: string; route_name: string }>;
      expect(resolved).toHaveLength(2);
      for (const edge of resolved) {
        expect(edge.route_name).toMatch(/ \/health$/);
        const target = db.prepare("SELECT name FROM nodes WHERE id = ?").get(edge.target) as { name: string };
        expect(target.name).toBe("health");
      }
    } finally {
      db.close();
    }
  });
});
