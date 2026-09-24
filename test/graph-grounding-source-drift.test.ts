/**
 * `mex check` grounds against a graph that is stale only because source
 * changed (#228).
 *
 * Before this, any source edit made the graph `stale` and switched grounding
 * off entirely until a full refresh, so the one edit grounding exists to catch
 * never moved the score. Now a node in an unchanged file is checked against the
 * snapshot, a node in an edited tree-sitter file is re-derived with the
 * extractor and body hash a refresh would use, and everything else is
 * GROUNDING_UNVERIFIED.
 *
 * The guard is the differential test: every grounded node's verdict without a
 * refresh must equal its verdict after a real rebuild, or be UNVERIFIED. A
 * different definite verdict is the one outcome that is never acceptable.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DriftIssue, Grounding, MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus, type GraphAwareDriftReport } from "../src/drift/index.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { loadGroundingRuntime, loadReadOnlyGroundingRuntime, refreshGroundingBaselines } from "../src/graph/runtime.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PY_BODY = `def compute_total(items):
    subtotal = sum(items)
    tax = subtotal * 0.18
    return subtotal + tax
`;
const PY_WHITESPACE = `def tidy(values):
    cleaned = [value.strip() for value in values]
    return cleaned
`;
const PY_RENAME = `def helper(value):
    doubled = value * 2
    return doubled + 1
`;
const PY_GONE = `def vanishing(value):
    return value - 42
`;
const PY_SHIFT = `def target(value):
    total = value + 7
    return total * 3
`;
const PY_STABLE = `def steady(value):
    return value + 1


def predrifted(value):
    return value * 5
`;
const TS_BODY = `export function calculateOrderTotal(items: number[]): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const tax = subtotal * 0.18;
  return subtotal + tax;
}
`;
const TS_GONE = `export function removedLater(value: number): number {
  return value - 42;
}
`;
const TS_SHIFT = `export function shiftedLater(value: number): number {
  const total = value + 7;
  return total * 3;
}
`;
const TS_STABLE = `export function stableTs(value: number): number {
  return value + 1;
}
`;

const SOURCES: Record<string, string> = {
  "py/body.py": PY_BODY,
  "py/whitespace.py": PY_WHITESPACE,
  "py/rename.py": PY_RENAME,
  "py/gone.py": PY_GONE,
  "py/shift.py": PY_SHIFT,
  "py/stable.py": PY_STABLE,
  "src/body.ts": TS_BODY,
  "src/gone.ts": TS_GONE,
  "src/shift.ts": TS_SHIFT,
  "src/stable.ts": TS_STABLE,
};

/** Grounded symbol → the file that defines it. */
const GROUNDED: Record<string, string> = {
  compute_total: "py/body.py",
  tidy: "py/whitespace.py",
  helper: "py/rename.py",
  vanishing: "py/gone.py",
  target: "py/shift.py",
  steady: "py/stable.py",
  predrifted: "py/stable.py",
  calculateOrderTotal: "src/body.ts",
  removedLater: "src/gone.ts",
  shiftedLater: "src/shift.ts",
  stableTs: "src/stable.ts",
};

/** The edits: body, comment-only, whitespace-only, rename, delete and line shift, in both languages. */
const EDITS: Record<string, string | null> = {
  "py/body.py": PY_BODY.replace("subtotal * 0.18", "subtotal * 0.21"),
  // A comment above the function plus re-indented body whitespace: no body change.
  "py/whitespace.py": `# Normalizes user input.\n${PY_WHITESPACE.replace("    cleaned = ", "    cleaned  =  ")}`,
  "py/rename.py": PY_RENAME.replace("def helper(", "def helper_renamed("),
  "py/gone.py": null,
  "py/shift.py": `def inserted_above(value):\n    return value\n\n\n${PY_SHIFT}`,
  "src/body.ts": TS_BODY.replace("subtotal * 0.18", "subtotal * 0.21"),
  "src/gone.ts": null,
  "src/shift.ts": `export function insertedAbove(value: number): number {\n  return value;\n}\n\n${TS_SHIFT}`,
};

interface Fixture {
  root: string;
  scaffold: string;
  config: MexConfig;
  ids: Record<string, string>;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "mex-grounding-source-drift-"));
  roots.push(root);
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["src"],
  }));
  for (const [path, text] of Object.entries(SOURCES)) write(root, path, text);
  const scaffold = join(root, ".mex", "context", "architecture.md");
  writeFileSync(scaffold, "---\nname: architecture\n---\n\n# Architecture\n");
  const config: MexConfig = { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] };
  await rebuild(root);

  // Ground every symbol the way `mex graph ground` does, then capture the
  // committed body hashes the way setup/sync does.
  const ids: Record<string, string> = {};
  const runtime = await loadGroundingRuntime(config);
  try {
    const groundings: Grounding[] = [];
    for (const [symbol, file] of Object.entries(GROUNDED)) {
      const node = runtime!.graph.searchNodes(symbol)
        .find((entry) => entry.name === symbol && entry.filePath === file && entry.kind === "function");
      if (!node) throw new Error(`fixture node missing: ${symbol}`);
      ids[symbol] = node.id;
      groundings.push({ node: node.id, fingerprint: serializeFingerprint(runtime!.reconciler.getFingerprint(node.id)!) });
    }
    const body = `\nSee [the deleted helper](mex://${ids.vanishing}) and [stable](mex://${ids.steady}).\n`;
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8") + body, groundings));
    refreshGroundingBaselines(config, [scaffold], runtime!);
  } finally {
    runtime!.close();
  }
  // A grounding that had already drifted before the edit, in a file that stays
  // untouched: the snapshot must still report it.
  const committed = extractGroundings(readFileSync(scaffold, "utf-8"));
  expect(committed.every((entry) => typeof entry.bodyHash === "string")).toBe(true);
  writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), committed.map((entry) =>
    entry.node === ids.predrifted ? { ...entry, bodyHash: "0".repeat(64) } : entry)));
  return { root, scaffold, config, ids };
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function applyEdits(root: string, edits: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(edits)) {
    if (text === null) rmSync(join(root, path));
    else write(root, path, text);
  }
}

/** Delete the disposable index and rebuild it: exactly what a refresh would record. */
async function rebuild(root: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, ".mex", `graph.db${suffix}`), { force: true });
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}

async function check(config: MexConfig): Promise<{ report: GraphAwareDriftReport; warnings: string[] }> {
  const warnings: string[] = [];
  const report = await runDriftCheckWithGraphStatus(config, { graphWarning: (message) => warnings.push(message) });
  return { report, warnings };
}

type Verdict = "OK" | DriftIssue["code"];

/** One verdict per grounded node id: the code of the grounding issue that names it, or OK. */
function verdicts(report: GraphAwareDriftReport, ids: Record<string, string>): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const [symbol, id] of Object.entries(ids)) {
    const named = report.issues.filter((entry) =>
      entry.code.startsWith("GROUNDING_") && entry.message.includes(id) && !entry.message.startsWith("Inline anchor"));
    out[symbol] = named[0]?.code ?? "OK";
  }
  return out;
}

function anchorVerdicts(report: GraphAwareDriftReport, ids: Record<string, string>): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const symbol of ["vanishing", "steady"]) {
    const named = report.issues.find((entry) =>
      entry.message.startsWith("Inline anchor") && entry.message.includes(ids[symbol]));
    out[symbol] = named?.code ?? "OK";
  }
  return out;
}

function groundingCodes(report: GraphAwareDriftReport): string[] {
  return report.issues.filter((entry) => entry.code.startsWith("GROUNDING_")).map((entry) => entry.code).sort();
}

describe("check grounds against a graph stale only by changed source (#228)", () => {
  it("never gives a definite verdict that differs from the verdict after a real refresh", async () => {
    const { root, config, ids } = await fixture();
    const baseline = await check(config);
    expect(baseline.report.graphStatus.status).toBe("fresh");
    expect(verdicts(baseline.report, ids)).toEqual({
      compute_total: "OK", tidy: "OK", helper: "OK", vanishing: "OK", target: "OK", steady: "OK",
      predrifted: "GROUNDING_DRIFT", calculateOrderTotal: "OK", removedLater: "OK", shiftedLater: "OK",
      stableTs: "OK",
    });

    applyEdits(root, EDITS);
    const stale = await check(config);
    expect(stale.report.graphStatus.status).toBe("stale");
    expect(stale.report.graphStatus.diagnostics.map((entry) => entry.code)).toContain("GRAPH_SOURCE_CORPUS_MISMATCH");
    const before = verdicts(stale.report, ids);
    const anchorsBefore = anchorVerdicts(stale.report, ids);

    await rebuild(root);
    const refreshed = await check(config);
    expect(refreshed.report.graphStatus.status).toBe("fresh");
    const after = verdicts(refreshed.report, ids);
    const anchorsAfter = anchorVerdicts(refreshed.report, ids);

    // The guard: identical, or UNVERIFIED. Never a different definite verdict.
    for (const symbol of Object.keys(ids)) {
      expect([after[symbol], "GROUNDING_UNVERIFIED"], symbol).toContain(before[symbol]);
    }
    for (const symbol of Object.keys(anchorsBefore)) {
      expect([anchorsAfter[symbol], "GROUNDING_UNVERIFIED"], `anchor ${symbol}`).toContain(anchorsBefore[symbol]);
    }

    // What each edit resolves to without a refresh, and after one.
    expect(before).toEqual({
      compute_total: "GROUNDING_DRIFT", // tree-sitter body edit: re-derived exactly
      tidy: "OK", // comment above + whitespace-only body edit: same normalized hash
      helper: "GROUNDING_UNVERIFIED", // renamed: never reconciled from a stale snapshot
      vanishing: "GROUNDING_UNVERIFIED", // file deleted: never reported GONE
      target: "OK", // function inserted above: lines shift, body unchanged
      steady: "OK", // unchanged file: the snapshot row stands
      predrifted: "GROUNDING_DRIFT", // unchanged file with a pre-existing drift
      calculateOrderTotal: "GROUNDING_UNVERIFIED", // compiler span needs a refresh
      removedLater: "GROUNDING_UNVERIFIED",
      shiftedLater: "GROUNDING_UNVERIFIED",
      stableTs: "OK", // unchanged TypeScript file
    });
    expect(after).toMatchObject({
      compute_total: "GROUNDING_DRIFT",
      tidy: "OK",
      vanishing: "GROUNDING_GONE",
      target: "OK",
      steady: "OK",
      predrifted: "GROUNDING_DRIFT",
      calculateOrderTotal: "GROUNDING_DRIFT",
      removedLater: "GROUNDING_GONE",
      shiftedLater: "OK",
      stableTs: "OK",
    });
    expect(anchorsBefore).toEqual({ vanishing: "GROUNDING_UNVERIFIED", steady: "OK" });
    expect(anchorsAfter.steady).toBe("OK");
    expect(stale.report.issues.some((entry) => entry.code === "GROUNDING_GONE")).toBe(false);
    expect(stale.warnings.join("\n")).toContain("re-read or marked unverified");
    expect(stale.warnings.join("\n")).not.toContain("grounding checks skipped");
  }, 120_000);

  it("detects a grounded-body edit before the refresh, and the score moves", async () => {
    const { root, config } = await fixture();
    const fresh = await check(config);
    expect(fresh.report.graphStatus.status).toBe("fresh");

    // Hono `compose()` / mex `extractGroundings`: a TypeScript body edit.
    applyEdits(root, { "src/body.ts": EDITS["src/body.ts"]! });
    const tsEdit = await check(config);
    expect(tsEdit.report.graphStatus.status).toBe("stale");
    expect(tsEdit.report.issues.filter((entry) => entry.code === "GROUNDING_UNVERIFIED")).toHaveLength(1);
    expect(tsEdit.report.issues.find((entry) => entry.code === "GROUNDING_UNVERIFIED")!.message)
      .toContain("mex graph refresh");
    expect(tsEdit.report.score).toBeLessThan(fresh.report.score);

    // A tree-sitter body edit is a definite drift, still without a refresh.
    applyEdits(root, { "py/body.py": EDITS["py/body.py"]! });
    const pyEdit = await check(config);
    expect(pyEdit.report.graphStatus.status).toBe("stale");
    expect(groundingCodes(pyEdit.report)).toEqual(["GROUNDING_DRIFT", "GROUNDING_DRIFT", "GROUNDING_UNVERIFIED"]);
    expect(pyEdit.report.score).toBeLessThan(tsEdit.report.score);
  }, 120_000);

  it("detects a deleted grounded symbol before the refresh", async () => {
    // Hono `testClient` / mex `createRepositoryGraphPort`: the defining code is removed.
    const { root, config, ids } = await fixture();
    const fresh = await check(config);
    writeFileSync(join(root, "src", "gone.ts"), "export const placeholder = 1;\n");
    applyEdits(root, { "py/gone.py": null });
    const stale = await check(config);
    expect(stale.report.graphStatus.status).toBe("stale");
    const unverified = stale.report.issues.filter((entry) => entry.code === "GROUNDING_UNVERIFIED");
    expect(unverified.some((entry) => entry.message.includes(ids.removedLater))).toBe(true);
    expect(unverified.some((entry) => entry.message.includes(ids.vanishing) && entry.message.includes("was deleted")))
      .toBe(true);
    expect(stale.report.score).toBeLessThan(fresh.report.score);
  }, 120_000);

  it("releases the bound graph descriptor when a read-only grounding runtime closes", async () => {
    // Stale checks now open readers too, so the leak this pins would reach
    // every check-then-refresh sequence. On Windows the open descriptor made
    // the next in-process refresh fail to replace graph.db.
    const { root, config } = await fixture();
    for (const stale of [false, true]) {
      if (stale) applyEdits(root, { "py/body.py": EDITS["py/body.py"]! });
      let descriptorClosed = false;
      const loaded = await loadReadOnlyGroundingRuntime(config, {
        allowSourceDrift: true,
        __internal: { afterDatabaseDescriptorClose: () => { descriptorClosed = true; } },
      } as unknown as Parameters<typeof loadReadOnlyGroundingRuntime>[1]);
      expect(loaded.graphStatus.status).toBe(stale ? "stale" : "fresh");
      expect(loaded.sourceDrift === true).toBe(stale);
      expect(descriptorClosed).toBe(false);
      loaded.runtime!.close();
      expect(descriptorClosed, stale ? "stale runtime" : "fresh runtime").toBe(true);
    }
    const refreshed = await loadGroundingRuntime(config);
    expect(refreshed).not.toBeNull();
    refreshed!.close();
  }, 120_000);

  it("still skips grounding when config changed, exactly as before", async () => {
    const { root, config } = await fixture();
    applyEdits(root, { "py/body.py": EDITS["py/body.py"]! });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "commonjs" }));
    const stale = await check(config);
    expect(stale.report.graphStatus.status).toBe("stale");
    expect(stale.report.graphStatus.changes.configChanged).toBe(true);
    expect(groundingCodes(stale.report)).toEqual([]);
    expect(stale.warnings.join("\n")).toContain("grounding checks skipped");
  }, 120_000);
});
