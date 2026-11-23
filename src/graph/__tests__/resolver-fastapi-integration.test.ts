import { currentGraphPath } from "../storage.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildGraph } from "../maintenance.js";
import { openGraphDatabase } from "../db/database.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FastAPI resolver integration", () => {
  // The unit tests call the resolver directly, which is exactly what hid the
  // detection bug: a manifest-based detect() never fires against a staged
  // corpus, so a real build produced zero routes (#113 review).
  it("persists route nodes and resolved function_ref edges through a real build", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-fastapi-integration-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
    writeFileSync(
      join(root, "src", "routers.py"),
      [
        "from fastapi import APIRouter",
        "",
        "users = APIRouter(prefix='/users')",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "app.py"),
      [
        "from fastapi import APIRouter, FastAPI",
        "from .routers import users",
        "",
        "app = FastAPI()",
        "reports = APIRouter(prefix='/reports')",
        "",
        "@app.get('/health')",
        "async def health():",
        "    return {'ok': True}",
        "",
        "@users.get(",
        "    '/{user_id}',",
        "    response_model=None,",
        ")",
        "def read_user(user_id: str):",
        "    return {'user_id': user_id}",
        "",
        "@reports.get('/{report_id}')",
        "def read_report(report_id: str):",
        "    return {'report_id': report_id}",
        "",
      ].join("\n"),
    );

    const result = await rebuildGraph(root);
    expect(result.status.status).toBe("fresh");

    const db = openGraphDatabase(currentGraphPath(root), { readOnly: true, immutable: true });
    try {
      const routes = db.prepare(
        "SELECT id, name, signature FROM nodes WHERE kind = 'route' ORDER BY name",
      ).all() as Array<{ id: string; name: string; signature: string }>;
      // The imported router's own `prefix` is declared in another module, and
      // composing a prefix across files is out of scope here exactly as it is
      // for a Flask Blueprint registered elsewhere: `read_user` is reached
      // through the decorator, and its path is the decorated one. A router
      // constructed in this file does compose its prefix.
      expect(routes.map((route) => route.name)).toEqual([
        "GET /health",
        "GET /reports/{report_id}",
        "GET /{user_id}",
      ]);
      expect(routes[0]!.signature).toBe("GET /health -> health");

      const resolved = db.prepare(
        "SELECT e.target, n.name AS route_name FROM edges e JOIN nodes n ON n.id = e.source"
        + " WHERE e.kind = 'references' AND e.provenance = 'framework'"
        + " AND e.resolution_method = 'fastapi-route-handler'",
      ).all() as Array<{ target: string; route_name: string }>;
      expect(resolved).toHaveLength(3);
      const targets = resolved.map((edge) => (
        db.prepare("SELECT name FROM nodes WHERE id = ?").get(edge.target) as { name: string }
      ).name).sort();
      expect(targets).toEqual(["health", "read_report", "read_user"]);
    } finally {
      db.close();
    }
  });

  it("builds a module that declares the same route twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-fastapi-duplicate-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
    writeFileSync(
      join(root, "src", "app.py"),
      [
        "import os",
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        "",
        "if os.environ.get('DEBUG'):",
        "    @app.get('/debug')",
        "    def debug():",
        "        return {'debug': True}",
        "else:",
        "    @app.get('/debug')",
        "    def debug():",
        "        return {'debug': False}",
        "",
      ].join("\n"),
    );

    // Before the per-file ordinal, both declarations produced the same node id
    // and the build failed with "Graph staging invariant failed: duplicate
    // node id" — one file taking the whole graph down (#113 review).
    const result = await rebuildGraph(root);
    expect(result.status.status).toBe("fresh");

    const db = openGraphDatabase(currentGraphPath(root), { readOnly: true, immutable: true });
    try {
      const routes = db.prepare(
        "SELECT id, signature FROM nodes WHERE kind = 'route'",
      ).all() as Array<{ id: string; signature: string }>;
      expect(routes).toHaveLength(2);
      expect(new Set(routes.map((route) => route.id)).size).toBe(2);
      expect(routes.map((route) => route.signature)).toEqual([
        "GET /debug -> debug",
        "GET /debug -> debug",
      ]);
    } finally {
      db.close();
    }
  });
});
