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

describe("Next.js resolver integration", () => {
  it("persists route nodes and resolved edges through a real build", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-nextjs-integration-"));
    roots.push(root);
    const routeDir = join(root, "app", "api", "users");
    mkdirSync(routeDir, { recursive: true });
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture", dependencies: { next: "^15.0.0" },
    }));
    writeFileSync(
      join(routeDir, "route.ts"),
      [
        "export async function GET(): Promise<Response> {",
        "  return Response.json({ ok: true });",
        "}",
        "",
        "export const POST = async (): Promise<Response> => {",
        "  return new Response(null, { status: 201 });",
        "};",
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
      expect(routes.map((route) => route.name)).toEqual([
        "GET /api/users",
        "POST /api/users",
      ]);
      expect(routes[0]!.signature).toBe("GET /api/users -> GET");

      const resolved = db.prepare(
        "SELECT e.target, n.name AS route_name FROM edges e JOIN nodes n ON n.id = e.source"
        + " WHERE e.kind = 'references' AND e.provenance = 'framework' AND e.resolution_method = 'nextjs-route-handler'",
      ).all() as Array<{ target: string; route_name: string }>;
      expect(resolved).toHaveLength(2);
      for (const edge of resolved) {
        expect(edge.route_name).toMatch(/ \/api\/users$/);
        const target = db.prepare("SELECT name FROM nodes WHERE id = ?").get(edge.target) as { name: string };
        expect(["GET", "POST"]).toContain(target.name);
      }
    } finally {
      db.close();
    }
  });
});
