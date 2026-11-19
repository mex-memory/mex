import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { openRecord, openRecordReadOnly } from "../../record/index.js";
import { latestBuildUsage, recordBuildUsage, type BuildUsageRow } from "../../record/build-usage.js";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { graphLocation } from "../storage.js";

// The usage log (record migration 6): every build and refresh records its
// wall time, CPU time and peak memory, Node plus the compiler server.

/** Temporary folders this file made, removed after its tests; an open handle on Windows only leaves one behind. */
const temporaries: string[] = [];
function temporary(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(folder);
  return folder;
}
afterAll(() => {
  for (const folder of temporaries.splice(0)) {
    try { rmSync(folder, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a handle still open on Windows */ }
  }
});
function fixture(): string {
  const root = temporary("graph-usage-");
  writeFileSync(join(root, "a.ts"), "export function a(): number {\n  return 1;\n}\n");
  writeFileSync(join(root, "b.ts"), "import { a } from \"./a\";\nexport const b = (): number => a();\n");
  return root;
}

function rows(root: string): BuildUsageRow[] {
  const location = graphLocation(root);
  const reader = openRecordReadOnly()!;
  try {
    return reader.all<BuildUsageRow>("SELECT * FROM build_usage WHERE project_id=? AND checkout=? ORDER BY id", location.projectId, location.root);
  } finally {
    reader.close();
  }
}

describe("graph usage log", () => {
  it("records a build and a refresh run in the candidate process, with the compiler server's share", async () => {
    const root = fixture();
    await rebuildGraph(root, { candidateExecution: "process" });
    writeFileSync(join(root, "a.ts"), "export function a(): number {\n  return 2;\n}\n");
    await refreshGraph(root, { candidateExecution: "process" });
    const logged = rows(root);
    expect(logged.map((row) => [row.kind, row.result])).toEqual([["build", "ok"], ["refresh", "ok"]]);
    for (const row of logged) {
      expect(row.wall_ms).toBeGreaterThan(0);
      expect(row.cpu_ms).toBeGreaterThan(0);
      expect(row.peak_rss_mb).toBeGreaterThan(20);
    }
    // The candidate process reports the compiler server it ran.
    expect(logged[0]!.server_rss_mb ?? 0).toBeGreaterThan(0);
    expect(logged[0]!.peak_rss_mb).toBeGreaterThan(logged[0]!.server_rss_mb!);
    expect(logged[1]!.files).toBe(1);
    const location = graphLocation(root);
    const reader = openRecordReadOnly()!;
    try {
      const latest = latestBuildUsage(reader, location.projectId, location.root);
      expect(latest.build?.kind).toBe("build");
      expect(latest.refresh?.kind).toBe("refresh");
    } finally {
      reader.close();
    }
  });

  it("records an unchanged refresh and a failed one", async () => {
    const root = fixture();
    await rebuildGraph(root);
    await refreshGraph(root);
    await expect(refreshGraph(join(root, "missing"))).rejects.toThrow();
    expect(rows(root).map((row) => [row.kind, row.result])).toEqual([["build", "ok"], ["refresh", "unchanged"]]);
  });
});

describe("build usage rows", () => {
  function database(): DatabaseSync {
    const writer = openRecord({ home: temporary("usage-record-"), isNetwork: () => false });
    return writer.db;
  }

  it("sums warm updates per project per minute", () => {
    const db = database();
    const base = { projectId: "g-p", checkout: "/repo", kind: "warm" as const, files: 1, wallMs: 20, cpuMs: 15, result: "ok" as const };
    recordBuildUsage(db, { ...base, peakRssMb: 300, at: new Date("2026-11-19T10:00:05Z") });
    recordBuildUsage(db, { ...base, peakRssMb: 350, serverRssMb: 200, at: new Date("2026-11-19T10:00:55Z") });
    recordBuildUsage(db, { ...base, peakRssMb: 310, at: new Date("2026-11-19T10:01:10Z") });
    const all = db.prepare("SELECT ts,files,wall_ms,cpu_ms,peak_rss_mb,server_rss_mb,runs FROM build_usage ORDER BY ts").all();
    expect(all).toEqual([
      { ts: "2026-11-19T10:00:00.000Z", files: 2, wall_ms: 40, cpu_ms: 30, peak_rss_mb: 350, server_rss_mb: 200, runs: 2 },
      { ts: "2026-11-19T10:01:00.000Z", files: 1, wall_ms: 20, cpu_ms: 15, peak_rss_mb: 310, server_rss_mb: null, runs: 1 },
    ]);
    db.close();
  });

  it("keeps 90 days", () => {
    const db = database();
    const row = { projectId: "g-p", checkout: "/repo", kind: "build" as const, files: 3, wallMs: 1, cpuMs: 1, peakRssMb: 1, result: "ok" as const };
    recordBuildUsage(db, { ...row, at: new Date("2026-01-01T00:00:00Z") });
    recordBuildUsage(db, { ...row, at: new Date("2026-11-19T00:00:00Z") });
    expect(db.prepare("SELECT ts FROM build_usage").all()).toEqual([{ ts: "2026-11-19T00:00:00.000Z" }]);
    db.close();
  });
});
