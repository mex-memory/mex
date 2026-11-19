import { currentGraphPath } from "../src/graph/storage.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCommandDeps } from "../src/graph/cli-agent.js";
import { runGraphQuery, runImpact } from "../src/graph/cli-agent.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../src/graph/snapshot.js";
import { inspectGraphStatus } from "../src/graph/status.js";

const roots: string[] = [];
type Rec = Record<string, unknown>;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A store whose files parsed cleanly, then marked partial in place.
 *
 * Producing a genuinely partial parse from source is extractor-specific and
 * would pin this test to whatever the parser currently tolerates. What is
 * under test is the read gate's response to the recorded parse state, so the
 * recorded state is what the fixture sets.
 */
async function parseDegradedFixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-parse-degraded-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(root, "src", "a.ts"),
    "export function alpha(): number {\n  return beta();\n}\n"
    + "export function beta(): number {\n  return 1;\n}\n");
  writeFileSync(join(root, "src", "b.ts"),
    "export function gamma(): number {\n  return 2;\n}\n");
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
  const db = openSqlite(currentGraphPath(root));
  try {
    db.prepare("UPDATE files SET parse_status = 'partial' WHERE path = ?").run("src/b.ts");
    // The snapshot records parse health too, and a snapshot that disagrees
    // with the rows is corruption rather than degradation. Keep them in step,
    // exactly as a real partial parse would have written them.
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = ?")
      .get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
    const snapshot = parseGraphSnapshot(row.value);
    if (!snapshot) throw new Error("fixture has no snapshot");
    db.prepare("UPDATE project_metadata SET value = ? WHERE key = ?").run(
      serializeGraphSnapshot({
        ...snapshot,
        parseHealth: {
          ...snapshot.parseHealth,
          ok: snapshot.parseHealth.ok - 1,
          partial: snapshot.parseHealth.partial + 1,
        },
      }),
      GRAPH_SNAPSHOT_METADATA_KEY,
    );
  } finally {
    db.close();
  }
  return root;
}

async function capture(command: (deps: AgentCommandDeps) => void | Promise<void>): Promise<Rec[]> {
  const output: string[] = [];
  await command({ write: (line) => output.push(line) });
  return output.map((line) => JSON.parse(line) as Rec);
}

const statusRecord = (records: Rec[]): Rec | undefined =>
  records.find((record) => record.type === "status");

describe("graph reads from a parse-degraded store", () => {
  it("answers, and reports the answer as incomplete rather than stale", async () => {
    const root = await parseDegradedFixture();
    expect((await inspectGraphStatus({ projectRoot: root })).status).toBe("degraded");

    const records = await capture((deps) => runGraphQuery("who-calls", "beta", root, deps, {}));
    expect(records.find((record) => record.type === "error")).toBeUndefined();
    const status = statusRecord(records);
    expect(status).toMatchObject({
      graphStatus: "degraded",
      reasons: ["parse-degraded"],
      trusted: ["definitions", "containment", "source"],
      partialFiles: 1,
      failedFiles: 0,
    });
    // Incomplete is not out of date: the facts this store holds are still true.
    expect(status!.stale).toBeUndefined();
    const results = records.filter((record) => record.type === "result");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((record) => record.stale === undefined)).toBe(true);
  });

  it("answers impact from the same store", async () => {
    const root = await parseDegradedFixture();
    const records = await capture((deps) => runImpact("beta", root, deps, {}));
    expect(records.find((record) => record.type === "error")).toBeUndefined();
    expect(statusRecord(records)).toMatchObject({ reasons: ["parse-degraded"] });
    expect(records.filter((record) => record.type === "caller").length).toBeGreaterThan(0);
  });

  it("reports both shortfalls when config also drifted", async () => {
    const root = await parseDegradedFixture();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "commonjs" }));
    const records = await capture((deps) => runGraphQuery("who-calls", "beta", root, deps, {}));
    expect(records.find((record) => record.type === "error")).toBeUndefined();
    const status = statusRecord(records);
    expect(status).toMatchObject({
      graphStatus: "stale",
      reasons: ["config-drift", "parse-degraded"],
      stale: ["resolution", "edges"],
      partialFiles: 1,
    });
    // Config drift is what makes an edge-derived record untrustworthy.
    expect(records.filter((record) => record.type === "result")
      .every((record) => record.stale === true)).toBe(true);
  });

  it("still refuses when the store is degraded for a reason it cannot bound", async () => {
    const root = await parseDegradedFixture();
    const db = openSqlite(currentGraphPath(root));
    try {
      const row = db.prepare("SELECT value FROM project_metadata WHERE key = ?")
        .get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
      const snapshot = parseGraphSnapshot(row.value);
      if (!snapshot) throw new Error("fixture has no snapshot");
      // A different grammar is engine identity, not a bounded shortfall.
      db.prepare("UPDATE project_metadata SET value = ? WHERE key = ?").run(
        serializeGraphSnapshot({ ...snapshot, grammarHash: "0".repeat(64) }),
        GRAPH_SNAPSHOT_METADATA_KEY,
      );
    } finally {
      db.close();
    }
    const records = await capture((deps) => runGraphQuery("who-calls", "beta", root, deps, {}));
    expect(records.find((record) => record.type === "error"))
      .toMatchObject({ code: "GRAPH_UNAVAILABLE" });
    expect(statusRecord(records)).toBeUndefined();
  });
});
