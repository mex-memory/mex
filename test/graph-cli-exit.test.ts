import { describe, expect, it } from "vitest";
import { createGraphCliWriter } from "../src/graph-cli-output.js";
import { runGraphQuery, runImpact } from "../src/graph/cli-agent.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import type { GraphEngine } from "../src/graph/engine.js";

describe("graph executable error status", () => {
  it("keeps an invalid query error in JSONL and reports failure", () => {
    const lines: string[] = [];
    let failed = false;
    runGraphQuery("invalid-relation", "target", process.cwd(), {
      write: createGraphCliWriter((line) => lines.push(line), () => { failed = true; }),
    });
    expect(failed).toBe(true);
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([{ type: "error", code: "INVALID_QUERY" }]);
  });

  it("reports a missing impact target as failure without changing library process state", async () => {
    const lines: string[] = [];
    let failed = false;
    const originalExit = process.exitCode;
    const db = openSqlite(":memory:");
    db.exec("CREATE TABLE nodes (id TEXT, file_path TEXT)");
    const graph = { getNode: () => null, searchNodes: () => [] } as unknown as GraphEngine;
    await runImpact("requirements.txt", process.cwd(), {
      open: () => ({ graph, db, close: () => db.close() }),
      write: createGraphCliWriter((line) => lines.push(line), () => { failed = true; }),
    });
    expect(failed).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "error", code: "TARGET_NOT_FOUND" });
    expect(process.exitCode).toBe(originalExit);
  });

  it("does not fail for notices or a truncated successful result", () => {
    let failed = false;
    const lines = ['{"type":"notice","code":"PARTIAL"}', '{"type":"summary","truncated":true}'];
    const received: string[] = [];
    const write = createGraphCliWriter((line) => received.push(line), () => { failed = true; });
    lines.forEach(write);
    expect(failed).toBe(false);
    expect(received).toEqual(lines);
  });
});
