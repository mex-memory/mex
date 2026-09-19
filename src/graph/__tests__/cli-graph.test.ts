import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GraphParseHealth, GraphSourceChanges, GraphStatus } from "../../team/contracts/graph.js";
import { runGraphScope } from "../cli-agent.js";
import {
  formatGraphLastSuccessfulIndex,
  formatGraphParseHealth,
  formatGraphSourceChanges,
  formatGraphStatusSources,
  runGraph,
  runGraphRefresh,
  runGraphRebuild,
} from "../cli-graph.js";

function changes(overrides: Partial<GraphSourceChanges> = {}): GraphSourceChanges {
  return {
    total: 0,
    added: [],
    modified: [],
    deleted: [],
    truncated: false,
    branchChanged: false,
    manifestChanged: false,
    configChanged: false,
    grammarChanged: false,
    ...overrides,
  };
}

function parseHealth(overrides: Partial<GraphParseHealth> = {}): GraphParseHealth {
  return {
    total: 0,
    ok: 0,
    partial: 0,
    failed: 0,
    failedPaths: [],
    failedPathsTruncated: false,
    ...overrides,
  };
}

function status(overrides: Partial<GraphStatus> = {}): GraphStatus {
  return {
    status: "degraded",
    observedAt: "2026-09-13T04:33:14.973Z",
    currentRepo: {
      branch: "main",
      head: "df89810df4f5aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      dirty: false,
      observedAt: "2026-09-13T04:33:14.973Z",
    },
    lastSuccessfulIndexAt: null,
    indexedAt: null,
    indexedBranch: null,
    indexedHead: null,
    schemaVersion: null,
    extractorVersion: null,
    grammarVersion: null,
    parseHealth: parseHealth(),
    changes: changes(),
    diagnostics: [],
    ...overrides,
  };
}

describe("graph CLI status formatting", () => {
  it("does not print placeholder zeros when immutable inspection was skipped", () => {
    const skipped = status({
      inspected: false,
      diagnostics: [{
        code: "GRAPH_INDEX_SIDECAR_ACTIVE",
        severity: "warning",
        message: "Graph maintenance or recovery is active (graph.db-wal); immutable inspection was skipped.",
      }],
    });

    expect(formatGraphParseHealth(skipped)).toBe("Parse health: not inspected (graph.db-wal present)");
    expect(formatGraphParseHealth(skipped)).not.toMatch(/\b0 ok\b/);
    expect(formatGraphLastSuccessfulIndex(skipped)).toBe("Last successful index: not inspected");
    expect(formatGraphLastSuccessfulIndex(skipped)).not.toContain("never");
    expect(formatGraphStatusSources(skipped)).toBe("Sources: not inspected");
    expect(formatGraphStatusSources(skipped)).not.toMatch(/0 changed/);
  });

  it("prints measured parse health for an inspected graph", () => {
    const inspected = status({
      status: "stale",
      inspected: true,
      lastSuccessfulIndexAt: "2026-09-13T04:33:14.973Z",
      parseHealth: parseHealth({ total: 111, ok: 111 }),
      changes: changes({ total: 1, deleted: ["src/gone.ts"] }),
    });

    expect(formatGraphParseHealth(inspected)).toBe("Parse health: 111 ok, 0 partial, 0 failed");
    expect(formatGraphLastSuccessfulIndex(inspected)).toBe("Last successful index: 2026-09-13T04:33:14.973Z");
    expect(formatGraphStatusSources(inspected)).toBe("Sources: 1 changed (0 added, 0 modified, 1 deleted)");
  });

  it("treats omitted inspected as measured so existing consumers stay valid", () => {
    const measuredEmpty = status();
    expect(formatGraphParseHealth(measuredEmpty)).toBe("Parse health: 0 ok, 0 partial, 0 failed");
    expect(formatGraphLastSuccessfulIndex(measuredEmpty)).toBe("Last successful index: never");
    expect(formatGraphStatusSources(measuredEmpty)).toBe("Sources: 0 changed (0 added, 0 modified, 0 deleted)");
  });

  it("labels bounded path arrays as shown instead of an exact breakdown", () => {
    const rendered = formatGraphSourceChanges(changes({
      total: 125,
      added: ["src/a.ts"],
      modified: ["src/b.ts", "src/c.ts"],
      truncated: true,
    }));

    expect(rendered).toBe(
      "Sources: 125 changed (1 added shown, 2 modified shown, 0 deleted shown; 122 paths omitted)",
    );
    expect(rendered).not.toContain("1 added, 2 modified, 0 deleted");
  });
});


describe("graph CLI cached coverage", () => {
  it("reports the same cached coverage after build, refresh and rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-coverage-cli-"));
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    try {
      writeFileSync(join(root, "api.ts"), "export const api = true;");
      await runGraph({ root, json: true });
      const fullyCovered: Record<string, unknown>[] = [];
      runGraphScope("api", root, { write: (line) => fullyCovered.push(JSON.parse(line)) });
      expect(fullyCovered.at(-1)).toMatchObject({ status: "ok", warnings: [] });
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", "App.vue"), "<template />");
      // A fully covered build records nothing to report, so reads skip verification:
      // the new file stays silent until the next build, exactly as before coverage existed.
      const afterAddition: Record<string, unknown>[] = [];
      runGraphScope("checkout cart pricing", root, { write: (line) => afterAddition.push(JSON.parse(line)) });
      expect(afterAddition.at(-1)).toMatchObject({ status: "no-match", warnings: [] });
      for (const command of [runGraph, runGraphRefresh, runGraphRebuild]) {
        output.length = 0;
        await command({ root, json: true });
        expect(JSON.parse(output.join(""))).toHaveProperty("unindexedSources", {
          total: 1, byExtension: { ".vue": 1 }, truncated: false,
        });
      }
      output.length = 0;
      await runGraphRefresh({ root });
      expect(output.some((line) => line.includes("Not indexed: 1") && line.includes(".vue (1)"))).toBe(true);
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
