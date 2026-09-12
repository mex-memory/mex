import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { rebuildGraph } from "../src/graph/maintenance.js";
import {
  loadGroundingRuntime,
  loadReadOnlyGroundingRuntime,
  persistMovedGroundings,
  previewGroundingBaseline,
  refreshGroundingBaselines,
  type GroundingRuntime,
} from "../src/graph/runtime.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import { buildCombinedBrief } from "../src/sync/brief-builder.js";
import { deserializeFingerprint, serializeFingerprint } from "../src/graph/fingerprint.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import {
  inspectGraphSidecars,
  inspectGraphStatus,
  inspectGraphStatusWithFreshObservation,
} from "../src/graph/status.js";
import { GRAPH_SNAPSHOT_METADATA_KEY } from "../src/graph/snapshot.js";
import type { GraphStatus, GraphStatusKind } from "../src/team/contracts/graph.js";
import { runDoctor } from "../src/doctor.js";
import { loadDashboard } from "../src/tui.js";

const roots: string[] = [];

function fixture(): { root: string; config: MexConfig; source: string; scaffold: string } {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-integration-"));
  roots.push(root);
  const source = join(root, "src", "service.ts");
  const scaffold = join(root, ".mex", "context", "architecture.md");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(scaffold, "---\nname: architecture\n---\n\n# Architecture\n");
  return { root, source, scaffold, config: { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] } };
}

function graphPersistenceSnapshot(root: string) {
  const dbPath = join(root, ".mex", "graph.db");
  const db = openSqlite(dbPath, { readOnly: true, immutable: true });
  try {
    return {
      bytes: readFileSync(dbPath),
      mtimeMs: statSync(dbPath).mtimeMs,
      metadata: db.prepare(
        "SELECT key, value, updated_at FROM project_metadata ORDER BY key",
      ).all(),
    };
  } finally {
    db.close();
  }
}

type FilesystemSnapshotEntry =
  | { path: string; kind: "directory"; mtimeMs: number }
  | { path: string; kind: "file"; bytes: Buffer; mtimeMs: number };

function filesystemSnapshot(root: string): FilesystemSnapshotEntry[] {
  const records: FilesystemSnapshotEntry[] = [{
    path: ".",
    kind: "directory",
    mtimeMs: statSync(root).mtimeMs,
  }];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = absolute.slice(root.length + 1);
      if (entry.isDirectory()) {
        records.push({ path, kind: "directory", mtimeMs: statSync(absolute).mtimeMs });
        visit(absolute);
      } else if (entry.isFile()) {
        records.push({
          path,
          kind: "file",
          bytes: readFileSync(absolute),
          mtimeMs: statSync(absolute).mtimeMs,
        });
      }
    }
  };
  visit(root);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function graphStatus(status: GraphStatusKind): GraphStatus {
  return {
    status,
    observedAt: "2026-08-22T00:00:00.000Z",
    currentRepo: {
      branch: null,
      head: null,
      dirty: false,
      observedAt: "2026-08-22T00:00:00.000Z",
    },
    lastSuccessfulIndexAt: null,
    indexedAt: null,
    indexedBranch: null,
    indexedHead: null,
    schemaVersion: null,
    extractorVersion: null,
    grammarVersion: null,
    parseHealth: {
      total: 0,
      ok: 0,
      partial: 0,
      failed: 0,
      failedPaths: [],
      failedPathsTruncated: false,
    },
    changes: {
      total: 0,
      added: [],
      modified: [],
      deleted: [],
      truncated: false,
      branchChanged: false,
      manifestChanged: false,
      configChanged: false,
      grammarChanged: false,
    },
    diagnostics: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("code-graph grounding integration", () => {
  it("inspects status unconditionally without opening grounding readers when irrelevant", async () => {
    const { config } = fixture();
    const missing = graphStatus("missing");
    const loader = vi.fn(async () => ({ graphStatus: missing, runtime: null }));
    const warning = vi.fn();

    const report = await runDriftCheckWithGraphStatus(config, {
      scaffoldPatterns: ["ROUTER.md"],
      readOnlyGroundingRuntimeLoader: loader,
      graphWarning: warning,
    });

    expect(loader).toHaveBeenCalledWith(config, { loadRuntime: false });
    expect(report.graphStatus).toEqual(missing);
    expect(warning).not.toHaveBeenCalled();
  });

  it("leaves graph-aware output to first-party renderers unless a warning sink is supplied", async () => {
    const { config } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await runDriftCheckWithGraphStatus(config, {
      readOnlyGroundingRuntimeLoader: async () => ({
        graphStatus: graphStatus("missing"),
        runtime: null,
      }),
    });

    expect(report.graphStatus.status).toBe("missing");
    expect(warning).not.toHaveBeenCalled();
  });

  it("does not invent graph commands when status says maintenance is unsafe", async () => {
    const { config } = fixture();
    const warning = vi.fn();
    const missing: GraphStatus = {
      ...graphStatus("missing"),
      diagnostics: [{
        code: "GRAPH_REPO_UNAVAILABLE",
        severity: "warning",
        message: "Repository provenance could not be inspected safely.",
      }],
    };

    await runDriftCheckWithGraphStatus(config, {
      readOnlyGroundingRuntimeLoader: async () => ({ graphStatus: missing, runtime: null }),
      groundingRuntimeLoader: async () => null,
      graphWarning: warning,
    });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining("GRAPH_REPO_UNAVAILABLE"));
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining("Run `mex graph`"));
  });

  it("abstains before opening SQLite when the inspected graph is not fresh", async () => {
    const { config } = fixture();
    const stale = graphStatus("stale");
    const result = await loadReadOnlyGroundingRuntime(config, {
      inspectStatus: async () => stale,
    });

    expect(result).toEqual({ graphStatus: stale, runtime: null });
  });

  it("drops immutable readers when SQLite recovery activity starts during open", async () => {
    const { root, source, config } = fixture();
    writeFileSync(source, "export function stableGrounding(): number { return 1; }\n");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const inspectSidecars = vi.fn()
      .mockReturnValueOnce({ state: "clear" as const, paths: [] })
      .mockReturnValueOnce({ state: "active" as const, paths: ["graph.db-wal"] });

    const result = await loadReadOnlyGroundingRuntime(config, { inspectSidecars });

    expect(inspectSidecars).toHaveBeenCalledTimes(2);
    expect(result.runtime).toBeNull();
    expect(result.graphStatus.status).toBe("degraded");
    expect(result.graphStatus.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "GRAPH_INDEX_READER_SIDECAR_ACTIVITY" }),
    ]));
  });

  it("drops immutable readers whose snapshot identity differs from fresh status", async () => {
    const { root, source, config } = fixture();
    writeFileSync(source, "export function stableGrounding(): number { return 1; }\n");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const dbPath = join(root, ".mex", "graph.db");
    const inspected = await inspectGraphStatusWithFreshObservation({ projectRoot: root, dbPath });
    expect(inspected.graphStatus.status).toBe("fresh");
    expect(inspected.freshObservation).not.toBeNull();
    const mismatched: GraphStatus = {
      ...inspected.graphStatus,
      indexedHead: "a".repeat(40),
    };
    const inspectSidecars = vi.fn(() => ({ state: "clear" as const, paths: [] }));

    const result = await loadReadOnlyGroundingRuntime(config, {
      inspectSidecars,
      __internal: {
        inspectObservation: async () => ({
          ...inspected,
          graphStatus: mismatched,
        }),
      },
    } as unknown as Parameters<typeof loadReadOnlyGroundingRuntime>[1]);

    expect(inspectSidecars).toHaveBeenCalledTimes(1);
    expect(result.runtime).toBeNull();
    expect(result.graphStatus.status).toBe("degraded");
    expect(result.graphStatus.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED" }),
    ]));
  });

  it("rebuilds mutating grounding state from exact bytes despite restored size and mtime", async () => {
    const { root, source, config } = fixture();
    const original = "export function oldBodyFact(): number { return 1; }\n";
    const replacement = "export function newBodyFact(): number { return 2; }\n";
    const fixedTime = new Date("2024-01-01T00:00:00.000Z");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    writeFileSync(source, original);
    utimesSync(source, fixedTime, fixedTime);
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    writeFileSync(source, replacement);
    utimesSync(source, fixedTime, fixedTime);
    expect(statSync(source).mtimeMs).toBe(fixedTime.getTime());

    const runtime = await loadGroundingRuntime(config);
    expect(runtime).not.toBeNull();
    expect(runtime!.graph.searchNodes("oldBodyFact").some((node) => node.name === "oldBodyFact"))
      .toBe(false);
    expect(runtime!.graph.searchNodes("newBodyFact").some((node) => node.name === "newBodyFact"))
      .toBe(true);
    runtime!.close();

    const db = openSqlite(join(root, ".mex", "graph.db"), { readOnly: true, immutable: true });
    try {
      const grounded = db.prepare("SELECT COUNT(*) AS count FROM _mex_grounded_source")
        .get() as { count: number };
      expect(grounded.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("builds fingerprints, detects body drift, re-grounds, and durably rewrites MOVED", async () => {
    const { root, source, scaffold, config } = fixture();
    const original = `export function calculateOrderTotal(items: number[]): number {\n  const subtotal = items.reduce((sum, item) => sum + item, 0);\n  const tax = subtotal * 0.18;\n  const shipping = subtotal > 1000 ? 0 : 75;\n  const discount = items.length > 5 ? subtotal * 0.05 : 0;\n  return subtotal + tax + shipping - discount;\n}\n`;
    writeFileSync(source, original);

    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const node = engine.searchNodes("calculateOrderTotal").find((entry) => entry.kind === "function")!;
    expect(node).toBeDefined();
    engine.close();

    let runtime = await loadGroundingRuntime(config);
    expect(runtime).not.toBeNull();
    const fingerprint = runtime!.reconciler.getFingerprint(node.id);
    expect(fingerprint?.tokenCount).toBeGreaterThan(30);
    expect(fingerprint?.minhash).toHaveLength(64);
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: node.id,
      fingerprint: serializeFingerprint(fingerprint!),
    }]) + `\n[\`calculateOrderTotal()\`](mex://${node.id})\n`);
    refreshGroundingBaselines(config, [scaffold], runtime!);
    runtime!.close();
    const initialFingerprint = extractGroundings(readFileSync(scaffold, "utf-8"))[0].fingerprint;

    writeFileSync(source, original.replace(
      "subtotal > 1000 ? 0 : 75",
      "Math.max(0, 75 - subtotal * 0.05)",
    ));
    const beforeCheck = graphPersistenceSnapshot(root);
    const warning = vi.fn();
    let report = await runDriftCheckWithGraphStatus(config, { graphWarning: warning });
    expect(report.graphStatus?.status).toBe("stale");
    expect(report.issues.filter((issue) => issue.code === "GROUNDING_DRIFT")).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Run `mex graph refresh`"));
    expect(graphPersistenceSnapshot(root)).toEqual(beforeCheck);

    // Explicitly mutating workflows retain the existing correctness-first sync.
    runtime = await loadGroundingRuntime(config);
    runtime!.close();
    const beforeFreshCheck = graphPersistenceSnapshot(root);
    report = await runDriftCheckWithGraphStatus(config, { graphWarning: warning });
    expect(report.graphStatus?.status).toBe("fresh");
    expect(report.issues.filter((issue) => issue.code === "GROUNDING_DRIFT")).toHaveLength(1);
    expect(graphPersistenceSnapshot(root)).toEqual(beforeFreshCheck);
    runtime = await loadGroundingRuntime(config);
    const bodyRepairBrief = await buildCombinedBrief([{
      file: ".mex/context/architecture.md", gitDiff: null,
      issues: report.issues.filter((issue) => issue.code === "GROUNDING_DRIFT"),
    }], root, { config, runtime: runtime! });
    expect(bodyRepairBrief).toContain("GROUNDING REPAIR");
    expect(bodyRepairBrief).toContain("user explicitly accepts that entry");
    expect(bodyRepairBrief).toContain('mex graph scope "<behavior being repaired>"');
    expect(bodyRepairBrief).toContain("fingerprints belong ONLY in grounds_to");
    const acceptance = previewGroundingBaseline(config, ".mex/context/architecture.md", node.id, runtime!)!.acceptance;
    refreshGroundingBaselines(config, [scaffold], runtime!, { acceptedGroundings: [acceptance] });
    runtime!.close();
    const refreshedContent = readFileSync(scaffold, "utf-8");
    expect(extractGroundings(refreshedContent)[0].fingerprint).not.toBe(initialFingerprint);
    report = await runDriftCheckWithGraphStatus(config, { graphWarning: warning });
    expect(report.graphStatus?.status).toBe("fresh");
    expect(report.issues.filter((issue) => issue.code.startsWith("GROUNDING_"))).toHaveLength(0);

    writeFileSync(source, readFileSync(source, "utf-8").replace("calculateOrderTotal", "computeOrderTotal"));
    runtime = await loadGroundingRuntime(config);
    const candidate = runtime!.graph.searchNodes("computeOrderTotal").find((entry) => entry.kind === "function")!;
    const ambiguousBrief = await buildCombinedBrief([{
      file: ".mex/context/architecture.md",
      gitDiff: null,
      issues: [{
        code: "GROUNDING_AMBIGUOUS", severity: "warning", file: ".mex/context/architecture.md", line: null,
        message: `Grounded node may have moved: ${node.id}; candidate: ${candidate.id}`,
      }],
    }], root, { config, runtime: runtime! });
    expect(ambiguousBrief).toContain(`Node: ${node.id} (candidate: ${candidate.id})`);
    expect(ambiguousBrief).toContain("Old body:");
    expect(ambiguousBrief).toContain("New body:");
    const anchorAmbiguousBrief = await buildCombinedBrief([{
      file: ".mex/context/architecture.md",
      gitDiff: null,
      issues: [{
        code: "GROUNDING_AMBIGUOUS", severity: "warning", file: ".mex/context/architecture.md", line: null,
        message: `Inline anchor may have moved: ${node.id}; candidate: ${candidate.id}`,
      }],
    }], root, { config, runtime: runtime! });
    expect(anchorAmbiguousBrief).toContain(`candidate: ${candidate.id}`);
    expect(anchorAmbiguousBrief).toContain("Old body:");
    expect(anchorAmbiguousBrief).toContain("New body:");
    expect(anchorAmbiguousBrief).toContain("AMBIGUOUS: adjudicate the surfaced candidate");
    expect(anchorAmbiguousBrief).toContain("any matching inline anchor");
    const moved = persistMovedGroundings(config, [scaffold], runtime!);
    const oldHash = extractGroundings(refreshedContent)[0].bodyHash;
    runtime!.close();
    expect(moved).toBe(2);
    const persisted = extractGroundings(readFileSync(scaffold, "utf-8"));
    expect(persisted[0].node).not.toBe(node.id);
    expect(persisted[0].node).toContain("function:");
    expect(persisted[0].bodyHash).toBe(oldHash);
    const persistedContent = readFileSync(scaffold, "utf-8");
    expect(persistedContent).not.toContain(`mex://${node.id}`);
    expect(persistedContent).toContain(`mex://${persisted[0].node}`);
    report = await runDriftCheckWithGraphStatus(config, { graphWarning: warning });
    expect(report.graphStatus?.status).toBe("fresh");
    expect(report.issues.filter((issue) => issue.code.startsWith("GROUNDING_"))).toMatchObject([
      { code: "GROUNDING_DRIFT" },
    ]);
  }, 20_000);

  it("migrates an inline anchor atomically when grounds_to and the anchor share a moved node (#128)", async () => {
    const { root, scaffold, config } = fixture();
    const source = join(root, "src", "service.ts");
    writeFileSync(source, "export function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n");

    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const node = engine.searchNodes("calculateTotal").find((entry) => entry.kind === "function")!;
    engine.close();

    // Ground the node BOTH in frontmatter and as an inline anchor — the shape
    // the stack.md template encourages.
    let runtime = await loadGroundingRuntime(config);
    const fingerprint = runtime!.reconciler.getFingerprint(node.id);
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: node.id,
      fingerprint: serializeFingerprint(fingerprint!),
    }]) + `\n[\`calculateTotal()\`](mex://${node.id})\n`);
    refreshGroundingBaselines(config, [scaffold], runtime!);
    runtime!.close();

    // Move the function to another file with an identical body, replace the
    // original, and rebuild: the old node id vanishes from the store entirely.
    const movedSource = join(root, "src", "moved.ts");
    writeFileSync(movedSource, readFileSync(source, "utf-8"));
    writeFileSync(source, "export const unrelated = 1;\n");
    const rebuilt = createGraphEngine({ rootDir: root });
    await rebuilt.build();
    const movedNode = rebuilt.searchNodes("calculateTotal").find((entry) => entry.kind === "function")!;
    expect(movedNode.id).not.toBe(node.id);
    rebuilt.close();

    runtime = await loadGroundingRuntime(config);
    const moved = persistMovedGroundings(config, [scaffold], runtime!);
    runtime!.close();

    expect(moved).toBe(2); // grounds_to entry + inline anchor, one resolution
    const persistedContent = readFileSync(scaffold, "utf-8");
    expect(persistedContent).not.toContain(`mex://${node.id}`);
    expect(persistedContent).toContain(`mex://${movedNode.id}`);
    expect(extractGroundings(persistedContent)[0].node).toBe(movedNode.id);

    // The next check must not report the anchor as gone.
    const report = await runDriftCheckWithGraphStatus(config, { graphWarning: () => {} });
    expect(report.issues.filter((issue) => issue.code === "GROUNDING_GONE")).toHaveLength(0);
  }, 20_000);

  it("migrates the inline anchor from the grounds_to resolution even when the store lost the old node's rows (#128)", async () => {
    const { root, scaffold, config } = fixture();
    const source = join(root, "src", "service.ts");
    writeFileSync(source, "export function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n");

    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const node = engine.searchNodes("calculateTotal").find((entry) => entry.kind === "function")!;
    engine.close();

    let runtime = await loadGroundingRuntime(config);
    const fingerprint = runtime!.reconciler.getFingerprint(node.id);
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: node.id,
      fingerprint: serializeFingerprint(fingerprint!),
    }]) + `\n[\`calculateTotal()\`](mex://${node.id})\n`);
    refreshGroundingBaselines(config, [scaffold], runtime!);
    runtime!.close();

    const movedSource = join(root, "src", "moved.ts");
    writeFileSync(movedSource, readFileSync(source, "utf-8"));
    writeFileSync(source, "export const unrelated = 1;\n");
    const rebuilt = createGraphEngine({ rootDir: root });
    await rebuilt.build();
    const movedNode = rebuilt.searchNodes("calculateTotal").find((entry) => entry.kind === "function")!;
    rebuilt.close();

    // A store where the old node's rows are already gone (the reporter's
    // post-move state): no grounded-source row, no fingerprint row, and no
    // compatibility alias. Without per-node atomic migration the anchor pass
    // finds no baseline and silently skips, leaving GROUNDING_GONE behind.
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      db.prepare("DELETE FROM _mex_grounded_source WHERE node_id = ?").run(node.id);
      db.prepare("DELETE FROM node_fingerprints WHERE node_id = ?").run(node.id);
      db.prepare("DELETE FROM node_aliases WHERE alias_id = ?").run(node.id);
    } finally {
      db.close();
    }

    runtime = await loadGroundingRuntime(config);
    const moved = persistMovedGroundings(config, [scaffold], runtime!);
    runtime!.close();

    expect(moved).toBe(2);
    const persistedContent = readFileSync(scaffold, "utf-8");
    expect(persistedContent).not.toContain(`mex://${node.id}`);
    expect(persistedContent).toContain(`mex://${movedNode.id}`);
    expect(extractGroundings(persistedContent)[0].node).toBe(movedNode.id);

    const report = await runDriftCheckWithGraphStatus(config, { graphWarning: () => {} });
    expect(report.issues.filter((issue) => issue.code === "GROUNDING_GONE")).toHaveLength(0);
  }, 20_000);

  it("migrates the inline anchor with its grounds_to entry when the anchor's own baseline is stale (#128)", async () => {
    const { root, scaffold, config } = fixture();
    const source = join(root, "src", "service.ts");
    writeFileSync(source, "export function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n");

    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const node = engine.searchNodes("calculateTotal").find((entry) => entry.kind === "function")!;
    engine.close();

    let runtime = await loadGroundingRuntime(config);
    const fingerprint = runtime!.reconciler.getFingerprint(node.id);
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: node.id,
      fingerprint: serializeFingerprint(fingerprint!),
    }]) + `\n[\`calculateTotal()\`](mex://${node.id})\n`);
    refreshGroundingBaselines(config, [scaffold], runtime!);
    runtime!.close();

    const movedSource = join(root, "src", "moved.ts");
    writeFileSync(movedSource, readFileSync(source, "utf-8"));
    writeFileSync(source, "export const unrelated = 1;\n");
    const rebuilt = createGraphEngine({ rootDir: root });
    await rebuilt.build();
    const movedNode = rebuilt.searchNodes("calculateTotal").find((entry) => entry.kind === "function")!;
    rebuilt.close();

    // The shape real stores reach without losing any rows: migrations refresh
    // the frontmatter fingerprint but copy the stored baseline verbatim, so the
    // stored row can keep a neighbour id that has since been re-identified.
    // That alone scores the anchor AMBIGUOUS while grounds_to scores MOVED.
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      const row = db.prepare("SELECT fingerprint FROM _mex_grounded_source WHERE node_id = ?")
        .get(node.id) as { fingerprint: string };
      const stored = deserializeFingerprint(row.fingerprint)!;
      const staleNeighbors = [...stored.neighbors, "function:00000000000000000000000000000000"].sort();
      db.prepare("UPDATE _mex_grounded_source SET fingerprint = ? WHERE node_id = ?")
        .run(serializeFingerprint({ ...stored, neighbors: staleNeighbors }), node.id);
      db.prepare("DELETE FROM node_fingerprints WHERE node_id = ?").run(node.id);
      db.prepare("DELETE FROM node_aliases WHERE alias_id = ?").run(node.id);
    } finally {
      db.close();
    }

    runtime = await loadGroundingRuntime(config);
    // Precondition: on its own, the anchor's stale baseline is not enough to move.
    const anchorBaseline = runtime!.reconciler.getGroundedSource(".mex/context/architecture.md", node.id)!;
    expect(runtime!.reconciler.reconcile(node.id, deserializeFingerprint(anchorBaseline.fingerprint)!))
      .toEqual({ kind: "AMBIGUOUS", candidate: movedNode.id });
    const moved = persistMovedGroundings(config, [scaffold], runtime!);
    runtime!.close();

    expect(moved).toBe(2);
    const persistedContent = readFileSync(scaffold, "utf-8");
    expect(persistedContent).not.toContain(`mex://${node.id}`);
    expect(persistedContent).toContain(`mex://${movedNode.id}`);
    expect(extractGroundings(persistedContent)[0].node).toBe(movedNode.id);

    const after = await runDriftCheckWithGraphStatus(config, { graphWarning: () => {} });
    expect(after.issues.filter((issue) => issue.code.startsWith("GROUNDING_"))).toHaveLength(0);
  }, 20_000);

  it("keeps legacy checks running when the graph engine fails to load", async () => {
    const { scaffold, config } = fixture();
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: "function:missing", fingerprint: "mh:64:00",
    }]));
    const warning = vi.fn();
    const report = await runDriftCheckWithGraphStatus(config, {
      groundingRuntimeLoader: async () => { throw new Error("simulated WASM load failure"); },
      graphWarning: warning,
      verbose: true,
    });
    expect(report.filesChecked).toBeGreaterThan(0);
    expect(report.issues.some((issue) => issue.code.startsWith("GROUNDING_"))).toBe(false);
    expect(report.verboseLog).toContain("Checker paths: 0 issues");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("simulated WASM load failure"));
  });

  it("closes the read-only runtime when a grounding checker throws", async () => {
    const { scaffold, config } = fixture();
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: "function:throws",
      fingerprint: "mh:64:00",
    }]));
    const close = vi.fn();
    const runtime = {
      checker: () => { throw new Error("simulated checker failure"); },
      close,
    } as unknown as GroundingRuntime;

    await expect(runDriftCheckWithGraphStatus(config, {
      readOnlyGroundingRuntimeLoader: async () => ({
        graphStatus: graphStatus("fresh"),
        runtime,
      }),
      graphWarning: vi.fn(),
    })).rejects.toThrow("simulated checker failure");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("probes WAL state on the canonical target of a contained graph symlink", async () => {
    const { root, config, source } = fixture();
    writeFileSync(source, "export const service = 1;\n");
    const graphPath = join(root, ".mex", "graph.db");
    const targetPath = join(root, ".mex", "graph-target.db");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    renameSync(graphPath, targetPath);
    symlinkSync("graph-target.db", graphPath);
    const fresh = await inspectGraphStatus({ projectRoot: root });
    expect(fresh.status).toBe("fresh");

    let writer: ReturnType<typeof openSqlite> | null = null;
    try {
      const loaded = await loadReadOnlyGroundingRuntime(config, {
        __internal: {
          afterStatusInspection() {
            writer = openSqlite(targetPath);
            writer.exec("PRAGMA wal_autocheckpoint = 0");
            writer.prepare("UPDATE project_metadata SET updated_at = ? WHERE key = 'manifest_hash'")
              .run(Date.now());
          },
        },
      } as unknown as Parameters<typeof loadReadOnlyGroundingRuntime>[1]);
      expect(loaded.runtime).toBeNull();
      expect(loaded.graphStatus.status).toBe("degraded");
      expect(loaded.graphStatus.diagnostics).toContainEqual(expect.objectContaining({
        code: "GRAPH_INDEX_READER_SIDECAR_ACTIVITY",
      }));
    } finally {
      writer?.close();
    }
  });

  it("rejects a graph that commits and checkpoints between immutable reader probes", async () => {
    const { root, config, source } = fixture();
    writeFileSync(source, "export const service = 1;\n");
    const graphPath = join(root, ".mex", "graph.db");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const fresh = await inspectGraphStatus({ projectRoot: root });
    expect(fresh.status).toBe("fresh");
    let probes = 0;

    const loaded = await loadReadOnlyGroundingRuntime(config, {
      inspectSidecars(path) {
        probes += 1;
        if (probes === 2) {
          const writer = openSqlite(graphPath);
          try {
            writer.prepare("UPDATE project_metadata SET updated_at = ? WHERE key = 'manifest_hash'")
              .run(Date.now());
            writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } finally {
            writer.close();
          }
        }
        return inspectGraphSidecars(path);
      },
    });

    expect(probes).toBe(2);
    expect(loaded.runtime).toBeNull();
    expect(loaded.graphStatus.status).toBe("degraded");
    expect(loaded.graphStatus.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
    }));
  });

  it("rejects an atomically replaced database whose public status fields still match", async () => {
    const { root, config, source } = fixture();
    writeFileSync(source, "export const service = 1;\n");
    const graphPath = join(root, ".mex", "graph.db");
    const replacementPath = join(root, ".mex", "graph-replacement.db");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    writeFileSync(replacementPath, readFileSync(graphPath));
    const replacement = openSqlite(replacementPath);
    try {
      const row = replacement.prepare(
        "SELECT value FROM project_metadata WHERE key = ?",
      ).get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
      const originalSnapshot = JSON.parse(row.value) as Record<string, unknown>;
      const forged = {
        ...originalSnapshot,
        manifestHash: "a".repeat(64),
        configHash: "b".repeat(64),
        compilerVersion: "forged-private-compiler",
        resolverVersion: "forged-private-resolver",
        semanticInputs: [{ path: "private-compiler.json", contentHash: null }],
      };
      expect(forged).toMatchObject({
        version: originalSnapshot.version,
        indexedAt: originalSnapshot.indexedAt,
        lastSuccessfulIndexAt: originalSnapshot.lastSuccessfulIndexAt,
        indexedBranch: originalSnapshot.indexedBranch,
        indexedHead: originalSnapshot.indexedHead,
        schemaVersion: originalSnapshot.schemaVersion,
        extractorVersion: originalSnapshot.extractorVersion,
        grammarHash: originalSnapshot.grammarHash,
        sourceCorpusDigest: originalSnapshot.sourceCorpusDigest,
        sourceCount: originalSnapshot.sourceCount,
        parseHealth: originalSnapshot.parseHealth,
      });
      replacement.prepare(
        "UPDATE project_metadata SET value = ? WHERE key = ?",
      ).run(JSON.stringify(forged), GRAPH_SNAPSHOT_METADATA_KEY);
      replacement.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      replacement.close();
    }
    expect(inspectGraphSidecars(replacementPath).state).toBe("clear");

    let openedReader: ReturnType<typeof openSqlite> | null = null;
    let descriptorClosed = false;
    let replaced = false;
    const loaded = await loadReadOnlyGroundingRuntime(config, {
      __internal: {
        afterDatabaseIdentityRead() {
          renameSync(replacementPath, graphPath);
          replaced = true;
        },
        afterDatabaseOpen(database) {
          openedReader = database;
        },
        afterDatabaseDescriptorClose() {
          descriptorClosed = true;
        },
      },
    } as unknown as Parameters<typeof loadReadOnlyGroundingRuntime>[1]);

    expect(replaced).toBe(true);
    expect(loaded.runtime).toBeNull();
    expect(loaded.graphStatus.status).toBe("degraded");
    expect(loaded.graphStatus.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
    }));
    expect(descriptorClosed).toBe(true);
    if (openedReader) expect(openedReader.open).toBe(false);
  });

  it("discards grounding results when the graph changes after the loader returns", async () => {
    const { root, config, source, scaffold } = fixture();
    writeFileSync(source, "export const service = 1;\n");
    const graphPath = join(root, ".mex", "graph.db");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const loaded = await loadReadOnlyGroundingRuntime(config);
    expect(loaded.runtime).not.toBeNull();

    const writer = openSqlite(graphPath);
    try {
      writer.prepare("UPDATE project_metadata SET updated_at = ? WHERE key = 'manifest_hash'")
        .run(Date.now());
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      writer.close();
    }

    const issues = loaded.runtime!.checker(
      null,
      scaffold,
      ".mex/context/architecture.md",
      root,
      join(root, ".mex"),
    );
    expect(issues).toEqual([]);
    expect(loaded.graphStatus.status).toBe("degraded");
    expect(loaded.graphStatus.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
      message: expect.stringContaining("results were discarded"),
    }));
    loaded.runtime!.close();
  });

  it("discards the whole grounding batch when a later file observes graph replacement", async () => {
    const { root, config, scaffold } = fixture();
    const secondScaffold = join(root, ".mex", "context", "stack.md");
    const grounding = [{ node: "function:service", fingerprint: "mh:64:00" }];
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), grounding));
    writeFileSync(secondScaffold, writeGroundings("# Stack\n", grounding));
    const fresh = graphStatus("fresh");
    fresh.diagnostics.push({
      code: "GRAPH_INDEX_HEAD_CHANGED",
      severity: "info",
      message: "The checkout HEAD differs but source contents still match.",
    });
    const close = vi.fn();
    const checker = vi.fn((_frontmatter, _filePath, source: string) => {
      if (checker.mock.calls.length === 1) {
        return [{
          code: "GROUNDING_DRIFT",
          severity: "warning" as const,
          file: source,
          line: null,
          message: "Finding derived from the original graph snapshot.",
        }];
      }
      fresh.status = "degraded";
      fresh.diagnostics.push({
        code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
        severity: "warning",
        message: "The graph changed while grounding checks were running; graph-derived results were discarded.",
      });
      return [];
    });
    const runtime = { checker, close } as unknown as GroundingRuntime;
    const warning = vi.fn();

    const report = await runDriftCheckWithGraphStatus(config, {
      scaffoldPatterns: ["context/*.md"],
      readOnlyGroundingRuntimeLoader: async () => ({ graphStatus: fresh, runtime }),
      graphWarning: warning,
    });

    expect(checker).toHaveBeenCalledTimes(2);
    expect(report.graphStatus.status).toBe("degraded");
    expect(report.issues.filter((issue) => issue.code.startsWith("GROUNDING_"))).toEqual([]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("results were discarded"));
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining("checkout HEAD differs"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps doctor and dashboard graph inspection filesystem-read-only", async () => {
    const { root, source, config } = fixture();
    writeFileSync(source, "export function service(): string { return 'v1'; }\n");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    writeFileSync(source, "export function service(): string { return 'v2'; }\n");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const beforeDoctor = filesystemSnapshot(join(root, ".mex"));
      await runDoctor(config);
      expect(filesystemSnapshot(join(root, ".mex"))).toEqual(beforeDoctor);
      expect(log.mock.calls.flat().join("\n")).toContain("stale; 1 source change");
      expect(warning).not.toHaveBeenCalled();

      const beforeDashboard = filesystemSnapshot(join(root, ".mex"));
      const dashboard = await loadDashboard(config);
      expect(dashboard.report.graphStatus.status).toBe("stale");
      expect(dashboard.report.graphStatus.changes.total).toBe(1);
      expect(filesystemSnapshot(join(root, ".mex"))).toEqual(beforeDashboard);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  }, 15_000);

  it("persists NestJS versioned routes through a real build without duplicate-id failures (#102)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-nestjs-integration-"));
    roots.push(root);
    const controller = join(root, "src", "users.controller.ts");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture", dependencies: { "@nestjs/common": "^10.0.0" },
    }));
    writeFileSync(controller, [
      "import { Controller, Get, Version } from '@nestjs/common';",
      "",
      "@Controller('users')",
      "export class UsersController {",
      "  @Version('1')",
      "  @Get()",
      "  findAllV1() { return ['v1']; }",
      "",
      "  @Version('2')",
      "  @Get()",
      "  findAllV2() { return ['v2']; }",
      "}",
      "",
      "// @Get('legacy')",
      "// legacyRoute() {}",
      "",
    ].join("\n"));

    const result = await rebuildGraph(root);
    expect(result.status.status).toBe("fresh");

    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      const routes = db.prepare(
        "SELECT name, signature FROM nodes WHERE kind = 'route' ORDER BY name",
      ).all() as Array<{ name: string; signature: string }>;
      // Both versioned routes persist with distinct ids; the commented-out
      // decorator produces no phantom route.
      expect(routes.map((route) => route.name)).toEqual(["GET /users", "GET /users"]);
      expect(new Set(routes.map((route) => route.signature))).toEqual(
        new Set(["GET /users -> findAllV1", "GET /users -> findAllV2"]),
      );
      expect(routes.some((route) => route.signature.includes("legacy"))).toBe(false);
    } finally {
      db.close();
    }
  }, 20_000);
});
