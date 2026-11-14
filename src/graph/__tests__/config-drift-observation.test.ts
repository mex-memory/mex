import { currentGraphPath } from "../storage.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../engine-impl.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  serializeGraphSnapshot,
  type GraphSnapshot,
} from "../snapshot.js";
import { inspectGraphStatusWithFreshObservation } from "../status.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-config-drift-"));
  roots.push(root);
  write(root, "package.json", JSON.stringify({ name: "fixture", dependencies: { dep: "1.0.0" } }));
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
  write(root, "src/a.ts", "export function alpha(): number {\n  return beta();\n}\n"
    + "export function beta(): number {\n  return 1;\n}\n");
  const engine = createGraphEngine({ rootDir: root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
  return root;
}

async function inspect(root: string) {
  return inspectGraphStatusWithFreshObservation({ projectRoot: root, now: NOW });
}

/**
 * Change a config field that genuinely affects extraction.
 *
 * A dependency *version* deliberately no longer registers: config inputs are
 * identified by the fields that decide what the compiler resolves. `type` is
 * one of those, so this is drift the graph must notice.
 */
function driftConfig(root: string): void {
  write(root, "package.json", JSON.stringify({
    name: "fixture", type: "commonjs", dependencies: { dep: "1.0.0" },
  }));
}

function updateSnapshot(root: string, update: (snapshot: GraphSnapshot) => GraphSnapshot): void {
  const db = openSqlite(currentGraphPath(root));
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = ?")
      .get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
    const snapshot = parseGraphSnapshot(row.value);
    if (!snapshot) throw new Error("test fixture has no valid graph snapshot");
    db.prepare("UPDATE project_metadata SET value = ?, updated_at = ? WHERE key = ?")
      .run(serializeGraphSnapshot(update(snapshot)), NOW.getTime(), GRAPH_SNAPSHOT_METADATA_KEY);
  } finally {
    db.close();
  }
}

describe("config-drift read observation", () => {
  it("binds a fresh store as fresh and never as drifted", async () => {
    const root = await project();
    const inspection = await inspect(root);
    expect(inspection.graphStatus.status).toBe("fresh");
    expect(inspection.freshObservation).not.toBeNull();
    expect(inspection.degradedObservation ?? null).toBeNull();
  });

  it("binds a store whose only drift is config content", async () => {
    const root = await project();
    driftConfig(root);
    const inspection = await inspect(root);
    expect(inspection.graphStatus.status).toBe("stale");
    expect(inspection.graphStatus.changes).toMatchObject({
      total: 0,
      configChanged: true,
      manifestChanged: true,
      grammarChanged: false,
      branchChanged: false,
    });
    expect(inspection.freshObservation).toBeNull();
    const observed = inspection.degradedObservation;
    expect(observed).not.toBeNull();
    expect(observed!.degradations).toEqual(["config-drift"]);
    expect(observed!.token.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseGraphSnapshot(observed!.token.snapshotRaw)).not.toBeNull();
  });

  it("is deterministic across repeated inspections of one drifted store", async () => {
    const root = await project();
    driftConfig(root);
    const first = await inspect(root);
    const second = await inspect(root);
    expect(second.degradedObservation).toEqual(first.degradedObservation);
  });

  it("refuses to bind when engine identity cannot be reproduced", async () => {
    const root = await project();
    driftConfig(root);
    updateSnapshot(root, (snapshot) => ({ ...snapshot, manifestHash: "0".repeat(64) }));
    const inspection = await inspect(root);
    expect(inspection.graphStatus.status).toBe("stale");
    expect(inspection.graphStatus.changes.configChanged).toBe(true);
    expect(inspection.freshObservation).toBeNull();
    expect(inspection.degradedObservation ?? null).toBeNull();
  });

  it("refuses to bind when the grammar also moved", async () => {
    const root = await project();
    driftConfig(root);
    updateSnapshot(root, (snapshot) => ({ ...snapshot, grammarHash: "0".repeat(64) }));
    const inspection = await inspect(root);
    expect(inspection.graphStatus.changes.grammarChanged).toBe(true);
    expect(inspection.degradedObservation ?? null).toBeNull();
  });

  it("binds a store with drifted source, and reports the exact drifted paths", async () => {
    const root = await project();
    driftConfig(root);
    write(root, "src/a.ts", "export function alpha(): number {\n  return 2;\n}\n");
    const inspection = await inspect(root);
    expect(inspection.graphStatus.status).toBe("stale");
    expect(inspection.graphStatus.changes.total).toBeGreaterThan(0);
    const observed = inspection.degradedObservation;
    expect(observed).not.toBeNull();
    expect(observed!.degradations).toEqual(["config-drift", "source-drift"]);
    // Complete, because a reader answers by excluding exactly this set.
    expect(observed!.driftedSources).toEqual(["src/a.ts"]);
  });

  it("counts a new unindexed file as drift and names it", async () => {
    const root = await project();
    driftConfig(root);
    write(root, "src/b.ts", "export const b = 1;\n");
    const inspection = await inspect(root);
    const observed = inspection.degradedObservation;
    expect(observed).not.toBeNull();
    expect(observed!.degradations).toContain("source-drift");
    expect(observed!.driftedSources).toEqual(["src/b.ts"]);
  });

  it("refuses to bind when more paths changed than the change list can carry", async () => {
    const root = await project();
    for (let index = 0; index < 6; index += 1) {
      write(root, `src/extra-${index}.ts`, `export const extra${index} = ${index};\n`);
    }
    // A truncated change list cannot be excluded from exhaustively, so the
    // store stops being serveable rather than being served incompletely.
    const inspection = await inspectGraphStatusWithFreshObservation({
      projectRoot: root, now: NOW, maxChangedPaths: 3,
    });
    expect(inspection.graphStatus.changes.truncated).toBe(true);
    expect(inspection.degradedObservation ?? null).toBeNull();
  });
});
