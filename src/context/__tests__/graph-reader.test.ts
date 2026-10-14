import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DB_SCHEMA_VERSION } from "../../graph/db/database.js";
import { openSqlite } from "../../graph/db/sqlite.js";
import { openGraphReader, READER_GRAPH_SCHEMA_VERSION } from "../graph-reader.js";
import { buildGraph, cleanupProjects, createProject } from "./fixture.js";

afterEach(cleanupProjects);

function nodeIn(root: string, file: string, name: string): string {
  const db = openSqlite(join(root, ".mex", "graph.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT id FROM nodes WHERE file_path = ? AND name = ?").get(file, name) as { id: string } | undefined;
    if (!row) throw new Error(`no node ${name} in ${file}`);
    return row.id;
  } finally {
    db.close();
  }
}

describe("light graph reader", () => {
  it("understands the graph schema this build writes", () => {
    // The reader checks the version itself so that it need not import the graph's database module.
    expect(READER_GRAPH_SCHEMA_VERSION).toBe(DB_SCHEMA_VERSION);
  });

  it("finds the smallest enclosing symbol of a line, never the file", async () => {
    const fx = createProject();
    fx.writeSource("src/a.ts", ["export class Box {", "  open(): number {", "    return 1;", "  }", "}", "", "export function free(): number {", "  return 2;", "}", ""].join("\n"));
    await buildGraph(fx);
    const { reader } = openGraphReader(fx.context.scaffoldRoot);
    try {
      expect(reader!.enclosing("src/a.ts", 3)).toMatchObject({ name: expect.stringContaining("open"), start: 2, end: 4 });
      expect(reader!.enclosing("src/a.ts", 8)).toMatchObject({ name: "free", start: 7, end: 9 });
      expect(reader!.enclosing("src/a.ts", 6)).toBeNull();
      expect(reader!.enclosing("src/missing.ts", 1)).toBeNull();
    } finally {
      reader!.close();
    }
  });

  it("finds callers by node id, not by name", async () => {
    const fx = createProject();
    fx.writeSource("src/a.ts", "export function render(): string {\n  return 'a';\n}\n");
    fx.writeSource("src/b.ts", "export function render(): string {\n  return 'b';\n}\n");
    fx.writeSource("src/useA.ts", 'import { render } from "./a.js";\n\nexport function runA(): string {\n  return render();\n}\n');
    fx.writeSource("src/useB.ts", 'import { render } from "./b.js";\n\nexport function runB(): string {\n  return render();\n}\n');
    await buildGraph(fx);
    const { reader } = openGraphReader(fx.context.scaffoldRoot);
    try {
      const callersOfA = reader!.callers(nodeIn(fx.root, "src/a.ts", "render"), 5);
      expect(callersOfA.map((c) => c.name)).toEqual(["runA"]);
      const callersOfB = reader!.callers(nodeIn(fx.root, "src/b.ts", "render"), 5);
      expect(callersOfB.map((c) => c.name)).toEqual(["runB"]);
      expect(reader!.callers(nodeIn(fx.root, "src/a.ts", "render"), 0)).toEqual([]);
    } finally {
      reader!.close();
    }
  });

  it("refuses a graph marked for rebuild, with a reason, and an absent graph", async () => {
    const fx = createProject();
    expect(openGraphReader(fx.context.scaffoldRoot).reader).toBeNull();
    fx.writeSource("src/a.ts", "export function one(): number {\n  return 1;\n}\n");
    await buildGraph(fx);
    const db = openSqlite(join(fx.root, ".mex", "graph.db"));
    db.prepare("INSERT INTO project_metadata (key, value, updated_at) VALUES ('rebuild_required', '1', 0) ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    db.close();
    const refused = openGraphReader(fx.context.scaffoldRoot);
    expect(refused.reader).toBeNull();
    expect(refused.reason).toMatch(/rebuild/i);
  });
});
