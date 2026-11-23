import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openRecord, openRecordReadOnly } from "../../record/index.js";
import { latestBuildUsage, recordBuildUsage, type BuildUsageRow } from "../../record/build-usage.js";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { graphLocation } from "../storage.js";
import { graphEngineBinary } from "../native-engine.js";
import { BackgroundGraph } from "../background-warm.js";
import { verifyGraph } from "../verify.js";
import { writeShift } from "../../file-index/shifts.js";

// The usage log (record migration 6): every build and refresh records its
// wall time, CPU time and peak memory.

/** Temporary folders this file made, removed after its tests; an open handle on Windows only leaves one behind. */
const temporaries: string[] = [];
afterEach(() => vi.unstubAllEnvs());
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
  it("records a build and a refresh run in the candidate process", async () => {
    vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
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
    vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
    const root = fixture();
    await rebuildGraph(root);
    await refreshGraph(root);
    await expect(refreshGraph(join(root, "missing"))).rejects.toThrow();
    expect(rows(root).map((row) => [row.kind, row.result])).toEqual([["build", "ok"], ["refresh", "unchanged"]]);
  });

  it.skipIf(!graphEngineBinary())("includes Rust CPU and peak RSS in native build, refresh, and resident edit usage", async () => {
    const root = fixture();
    const source = join(root, "a.ts");
    const build = await rebuildGraph(root);
    expect(build.status.schemaVersion).toBe(5);
    writeFileSync(source, "export function a(): number { return 2; }\n");
    const refresh = await refreshGraph(root);
    const location = graphLocation(root);
    const writer = openRecord();
    const background = new BackgroundGraph(writer, () => { throw new Error("unexpected cold refresh"); }, () => {});
    try {
      writeFileSync(source, "export function a(): number { return 3; }\n");
      const checkouts = join(location.directory, "checkouts");
      mkdirSync(checkouts, { recursive: true });
      writeFileSync(join(checkouts, `${location.key}.json`), JSON.stringify({ root: location.root }));
      writeShift(location.directory, location.key, { path: "a.ts", mtime_ns: "1", ranges: [] });
      writeFileSync(join(location.recordDirectory, "index-pending"), "");
      await background.collect();
      await background.run();
      expect(await verifyGraph(root)).toMatchObject({ status: "match" });
      const logged = rows(root);
      expect(logged.map(({ kind, result }) => [kind, result])).toEqual([
        ["build", "ok"], ["refresh", "ok"], ["warm", "ok"], ["verify", "ok"],
      ]);
      for (const row of logged) {
        expect(row.cpu_ms).toBeGreaterThan(0);
        expect(row.server_rss_mb).toBeGreaterThan(0);
        expect(row.peak_rss_mb).toBeGreaterThan(row.server_rss_mb!);
      }
      expect(logged[0]!.server_rss_mb).toBe(build.engine?.peakRssMb);
      expect(logged[1]!.server_rss_mb).toBe(refresh.engine?.peakRssMb);
      expect(logged[0]!.cpu_ms).toBeGreaterThanOrEqual(build.engine?.cpuMs ?? Infinity);
      expect(logged[1]!.cpu_ms).toBeGreaterThanOrEqual(refresh.engine?.cpuMs ?? Infinity);
    } finally {
      background.stop();
      writer.close();
    }
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
