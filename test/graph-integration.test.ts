import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MexConfig } from "../src/types.js";
import { runDriftCheck } from "../src/drift/index.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { loadGroundingRuntime, persistMovedGroundings, refreshGroundingBaselines } from "../src/graph/runtime.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import { buildCombinedBrief } from "../src/sync/brief-builder.js";

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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("code-graph grounding integration", () => {
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
      fingerprint: "mh:64:" + Buffer.from(JSON.stringify(fingerprint)).toString("hex"),
    }]));
    refreshGroundingBaselines(config, [scaffold], runtime!);
    runtime!.close();

    writeFileSync(source, original.replace("subtotal * 0.18", "subtotal * 0.20"));
    let report = await runDriftCheck(config);
    expect(report.issues.filter((issue) => issue.code === "GROUNDING_DRIFT")).toHaveLength(1);

    runtime = await loadGroundingRuntime(config);
    refreshGroundingBaselines(config, [scaffold], runtime!);
    runtime!.close();
    report = await runDriftCheck(config);
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
    const moved = persistMovedGroundings(config, [scaffold], runtime!);
    runtime!.close();
    expect(moved).toBe(1);
    const persisted = extractGroundings(readFileSync(scaffold, "utf-8"));
    expect(persisted[0].node).not.toBe(node.id);
    expect(persisted[0].node).toContain("function:");
    report = await runDriftCheck(config);
    expect(report.issues.filter((issue) => issue.code.startsWith("GROUNDING_"))).toHaveLength(0);
  });

  it("keeps legacy checks running when the graph engine fails to load", async () => {
    const { scaffold, config } = fixture();
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: "function:missing", fingerprint: "mh:64:00",
    }]));
    const warning = vi.fn();
    const report = await runDriftCheck(config, {
      groundingRuntimeLoader: async () => { throw new Error("simulated WASM load failure"); },
      graphWarning: warning,
      verbose: true,
    });
    expect(report.filesChecked).toBeGreaterThan(0);
    expect(report.issues.some((issue) => issue.code.startsWith("GROUNDING_"))).toBe(false);
    expect(report.verboseLog).toContain("Checker paths: 0 issues");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("simulated WASM load failure"));
  });
});
