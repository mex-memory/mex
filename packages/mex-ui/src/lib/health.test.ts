import { describe, it, expect } from "vitest";
import { buildRecommendations, describeScore, summarizeIssues } from "./health";
import type { DriftIssue, GraphStats, GroundingCoverage, ProjectSnapshot } from "./types";

function issue(overrides: Partial<DriftIssue> = {}): DriftIssue {
  return {
    code: "STALE_FILE",
    severity: "warning",
    file: ".mex/context/stack.md",
    line: null,
    message: "Not updated recently.",
    ...overrides,
  };
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    status: "ready",
    version: "0.7.2",
    root: "/repo",
    projectRoot: "/repo",
    projectName: "repo",
    isGitRepo: true,
    scaffoldRoot: "/repo/.mex",
    identity: null,
    aiTools: [],
    scaffold: { files: [], total: 11, present: 11, populated: 11 },
    graph: { present: true, path: "/repo/.mex/graph.db", bytes: 1024, modifiedAt: null },
    capturedAt: "2026-06-15T12:00:00.000Z",
    error: null,
    ...overrides,
  };
}

function graphStats(overrides: Partial<GraphStats> = {}): GraphStats {
  return {
    available: true,
    unavailable: null,
    totals: { nodes: 100, edges: 200, files: 10 },
    health: { indexedFiles: 10, okFiles: 10, partialFiles: 0, failedFiles: 0 },
    nodesByKind: [],
    edgesByKind: [],
    languages: [],
    recentFiles: [],
    manifestHash: null,
    ...overrides,
  };
}

function grounding(overrides: Partial<GroundingCoverage> = {}): GroundingCoverage {
  return {
    graphAvailable: true,
    authored: 0,
    captured: 0,
    needsCapture: false,
    files: [],
    error: null,
    ...overrides,
  };
}

describe("describeScore", () => {
  it("calls a clean report healthy", () => {
    const verdict = describeScore(100, []);
    expect(verdict.tone).toBe("good");
    expect(verdict.label).toBe("Healthy");
  });

  it("stays healthy when only warnings exist, and says how many", () => {
    const verdict = describeScore(94, [issue(), issue()]);
    expect(verdict.tone).toBe("good");
    expect(verdict.headline).toContain("2 warnings");
  });

  it("escalates to `drifting` for a first error", () => {
    const verdict = describeScore(90, [issue({ severity: "error" })]);
    expect(verdict.tone).toBe("warn");
    expect(verdict.label).toBe("Drifting");
    expect(verdict.headline).toContain("One claim");
  });

  it("escalates to `out of date` below the 70 point threshold", () => {
    const errors = Array.from({ length: 4 }, () => issue({ severity: "error" }));
    const verdict = describeScore(60, errors);
    expect(verdict.tone).toBe("bad");
    expect(verdict.label).toBe("Out of date");
    expect(verdict.headline).toContain("mex sync");
  });
});

describe("summarizeIssues", () => {
  it("groups by code and orders by severity then volume", () => {
    const summary = summarizeIssues([
      issue({ code: "STALE_FILE" }),
      issue({ code: "STALE_FILE" }),
      issue({ code: "STALE_FILE" }),
      issue({ code: "GROUNDING_MISSING", severity: "error" }),
      issue({ code: "TODO", severity: "info" }),
    ]);

    expect(summary.total).toBe(5);
    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(3);
    expect(summary.infos).toBe(1);
    expect(summary.groups.map((group) => group.code)).toEqual([
      "GROUNDING_MISSING",
      "STALE_FILE",
      "TODO",
    ]);
    expect(summary.groups[1].count).toBe(3);
  });

  it("presents a group at the worst severity any member has", () => {
    const summary = summarizeIssues([
      issue({ code: "MIXED", severity: "info" }),
      issue({ code: "MIXED", severity: "error" }),
    ]);
    expect(summary.groups[0].severity).toBe("error");
  });

  it("caps samples without losing the count", () => {
    const many = Array.from({ length: 10 }, () => issue({ code: "STALE_FILE" }));
    const summary = summarizeIssues(many, 3);
    expect(summary.groups[0].count).toBe(10);
    expect(summary.groups[0].samples).toHaveLength(3);
  });
});

describe("buildRecommendations", () => {
  it("says nothing when the project is in good shape", () => {
    const out = buildRecommendations({ snapshot: snapshot(), graph: graphStats(), issues: [] });
    expect(out).toEqual([]);
  });

  it("puts repairing a broken scaffold above everything else", () => {
    const out = buildRecommendations({
      snapshot: snapshot({
        status: "error",
        error: { message: "No ROUTER.md", hint: "Run setup", canRunSetup: true },
        scaffold: { files: [], total: 11, present: 1, populated: 0 },
      }),
      graph: graphStats({ available: false, unavailable: { reason: "missing", message: "none" } }),
      issues: [issue({ severity: "error" })],
    });
    expect(out[0].id).toBe("repair-scaffold");
  });

  it("offers an in-app build for a missing graph and a rebuild for a stale one", () => {
    const missing = buildRecommendations({
      snapshot: snapshot(),
      graph: graphStats({ available: false, unavailable: { reason: "missing", message: "none" } }),
      issues: [],
    });
    expect(missing[0].id).toBe("build-graph");
    expect(missing[0].action).toBe("build-graph");

    const stale = buildRecommendations({
      snapshot: snapshot(),
      graph: graphStats({
        available: false,
        unavailable: { reason: "needs-rebuild", message: "schema changed" },
      }),
      issues: [],
    });
    expect(stale[0].id).toBe("rebuild-graph");
    expect(stale[0].tone).toBe("warn");
  });

  it("does not ask to build the graph while a build is already running", () => {
    const out = buildRecommendations({
      snapshot: snapshot(),
      graph: graphStats({ available: false, unavailable: { reason: "missing", message: "none" } }),
      issues: [],
      graphBuilding: true,
    });
    expect(out.some((entry) => entry.action === "build-graph")).toBe(false);
  });

  it("counts unfilled scaffold files in the singular and plural", () => {
    const one = buildRecommendations({
      snapshot: snapshot({ scaffold: { files: [], total: 11, present: 11, populated: 10 } }),
      graph: graphStats(),
      issues: [],
    });
    expect(one[0].title).toBe("One wiki file is still a template");
    expect(one[0].action).toBe("open-setup");

    const many = buildRecommendations({
      snapshot: snapshot({ scaffold: { files: [], total: 11, present: 11, populated: 7 } }),
      graph: graphStats(),
      issues: [],
    });
    expect(many[0].title).toBe("4 wiki files are still a template");
  });

  it("recommends sync only for errors, not warnings", () => {
    const warnings = buildRecommendations({
      snapshot: snapshot(),
      graph: graphStats(),
      issues: [issue()],
    });
    expect(warnings.some((entry) => entry.id === "sync-drift")).toBe(false);

    const errors = buildRecommendations({
      snapshot: snapshot(),
      graph: graphStats(),
      issues: [issue({ severity: "error" })],
    });
    expect(errors.find((entry) => entry.id === "sync-drift")?.command).toBe("mex sync");
  });

  it("surfaces parse failures that silently shrink the graph", () => {
    const out = buildRecommendations({
      snapshot: snapshot(),
      graph: graphStats({
        health: { indexedFiles: 10, okFiles: 8, partialFiles: 0, failedFiles: 2 },
      }),
      issues: [],
    });
    expect(out[0].title).toBe("2 files failed to parse");
  });

  it("stays quiet while drift is still loading", () => {
    const out = buildRecommendations({ snapshot: snapshot(), graph: null, issues: null });
    expect(out).toEqual([]);
  });

  it("asks for a grounding capture ahead of the drift it would change", () => {
    const out = buildRecommendations({
      snapshot: snapshot(),
      graph: graphStats(),
      issues: [issue({ severity: "error" })],
      grounding: grounding({ authored: 4, captured: 1, needsCapture: true }),
    });

    expect(out.map((entry) => entry.id)).toEqual(["capture-grounding", "sync-drift"]);
    expect(out[0].title).toBe("3 grounded claims have no baseline");
  });

  it("says nothing about grounding once every reference has a baseline", () => {
    const out = buildRecommendations({
      snapshot: snapshot(),
      graph: graphStats(),
      issues: [],
      grounding: grounding({ authored: 4, captured: 4 }),
    });
    expect(out).toEqual([]);
  });
});
