import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGraphQuery } from "../cli-agent.js";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../engine-impl.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, "utf8");
}

/**
 * A repository whose call sites reference a name no declaration provides —
 * the shape a dynamically generated method leaves behind.
 */
async function repositoryWithDynamicCalls(): Promise<{ root: string; dbPath: string }> {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-unresolved-"));
  roots.push(root);
  const dbPath = join(root, "graph.db");
  // `any` receivers leave a real call site with no declaration to bind it to,
  // exactly as a dynamically generated method does.
  write(root, "src/first.ts", [
    "export function firstCaller(subject: any): void {",
    "  subject.markFailed();",
    "}",
    "",
  ].join("\n"));
  write(root, "src/second.ts", [
    "export function secondCaller(subject: any): void {",
    "  subject.markFailed();",
    "}",
    "",
  ].join("\n"));
  const engine = createGraphEngine({ rootDir: root, dbPath });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
  return { root, dbPath };
}

function query(root: string, dbPath: string, relation: string, target: string, options = {}) {
  const output: string[] = [];
  const db = openSqlite(`file:${dbPath.replaceAll("\\", "/")}?mode=ro&immutable=1`);
  const engine = createGraphEngine({ rootDir: root, dbPath, readOnly: true });
  try {
    runGraphQuery(relation, target, root, {
      open: () => ({ graph: engine, db, close: () => {} }),
      write: (line) => output.push(line),
    }, options);
  } finally {
    engine.close();
    db.close();
  }
  return output.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("who-calls falls back to recorded unresolved references", () => {
  it("reports call sites for a name with no indexed declaration", async () => {
    const { root, dbPath } = await repositoryWithDynamicCalls();

    const rows = query(root, dbPath, "who-calls", "markFailed");

    // The protocol stays uniform: meta first, summary last, like every other
    // response — not the bare error record this path used to emit.
    expect(rows[0]).toMatchObject({ type: "meta" });
    expect(rows.at(-1)).toMatchObject({ type: "summary" });

    const unresolved = rows.filter((row) => row.type === "unresolved-reference");
    expect(unresolved.length).toBeGreaterThan(0);
    // Never `type: "result"`: an agent must not confuse an unbound name for a
    // resolved graph fact.
    expect(rows.filter((row) => row.type === "result")).toEqual([]);
    for (const row of unresolved) {
      expect(row).toMatchObject({
        relation: "who-calls",
        target: "markFailed",
        name: "markFailed",
      });
      expect(typeof row.file).toBe("string");
      expect(typeof row.line).toBe("number");
      expect(typeof row.col).toBe("number");
      expect(typeof row.fromNode).toBe("string");
    }
    expect(unresolved.map((row) => row.file)).toEqual(["src/first.ts", "src/second.ts"]);
    const qualified = query(root, dbPath, "who-calls", "subject.markFailed")
      .filter((row) => row.type === "unresolved-reference");
    expect(qualified).toEqual(unresolved.map((row) => ({
      ...row, target: "subject.markFailed", receiver: "subject", qualifier: "subject",
    })));

    const summary = rows.at(-1)!;
    expect(summary).toMatchObject({ status: "partial", evidenceStrength: "weak", returnedNodes: 0 });
    expect((summary.warnings as string[]).join(" ")).toContain("markFailed");
    expect((summary.suggestedNextCommands as string[])[0]).toContain("mex graph get");
  }, 60_000);

  it("caps the fallback and declares the truncation", async () => {
    const { root, dbPath } = await repositoryWithDynamicCalls();

    const rows = query(root, dbPath, "who-calls", "markFailed", { maxNodes: 1 });

    expect(rows.filter((row) => row.type === "unresolved-reference")).toHaveLength(1);
    const summary = rows.at(-1)!;
    expect(summary.truncated).toBe(true);
    // The cap bounds the answer, not the count of what exists.
    expect(summary.matchedNodes).toBeGreaterThan(1);
  }, 60_000);

  it("still abstains when the name appears nowhere at all", async () => {
    const { root, dbPath } = await repositoryWithDynamicCalls();

    const rows = query(root, dbPath, "who-calls", "definitelyNotAName");

    expect(rows).toEqual([
      { type: "error", code: "TARGET_NOT_FOUND", target: "definitelyNotAName" },
    ]);
  }, 60_000);

  it("leaves where-defined and what-calls abstention unchanged", async () => {
    const { root, dbPath } = await repositoryWithDynamicCalls();

    for (const relation of ["where-defined", "what-calls"]) {
      expect(query(root, dbPath, relation, "markFailed")).toEqual([
        { type: "error", code: "TARGET_NOT_FOUND", target: "markFailed" },
      ]);
    }
  }, 60_000);
});
