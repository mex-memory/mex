import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GraphSourceChanges } from "../../team/contracts/graph.js";
import { runGraphScope } from "../cli-agent.js";
import {
  formatGraphSourceChanges,
  runGraph,
  runGraphRefresh,
  runGraphRebuild,
  runGraphStatus,
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

describe("graph CLI status formatting", () => {
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

  it("prints not inspected instead of zeros while a stranded WAL blocks inspection", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-status-wal-cli-"));
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    try {
      writeFileSync(join(root, "api.ts"), "export const api = true;");
      await runGraph({ root, json: true });
      writeFileSync(join(root, ".mex", "graph.db-wal"), "stranded");

      output.length = 0;
      await runGraphStatus({ root });
      expect(output).toContain("Last successful index: not inspected");
      expect(output).toContain("Sources: not inspected");
      expect(output).toContain("Parse health: not inspected");
      expect(output.some((line) => line.startsWith("WARNING GRAPH_INDEX_SIDECAR_ACTIVE"))).toBe(true);
      expect(output.some((line) => line.includes("0 ok") || line.includes("never"))).toBe(false);

      output.length = 0;
      await runGraphStatus({ root, json: true });
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "degraded", inspected: false });
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
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
