/**
 * A grounded body that changed only in its comments (#236).
 *
 * `bodyHash` still decides whether a body changed. `codeHash`, committed beside
 * it, decides whether anything but comments did: when only comments changed,
 * `mex check` reports an unscored GROUNDING_COMMENT_DRIFT notice instead of a
 * GROUNDING_DRIFT warning, and `mex sync` offers the explicit review rather
 * than an AI session. Every uncertain case keeps the warning.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { computeScore } from "../src/drift/scoring.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";
import { loadGroundingRuntime, refreshGroundingBaselines } from "../src/graph/runtime.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import { runSync } from "../src/sync/index.js";

vi.mock("../src/cli-tools.js", () => ({ isCliAvailable: () => true }));

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TS = `export function calculateOrderTotal(items: number[]): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const tax = subtotal * 0.18;
  const shipping = subtotal > 1000 ? 0 : 75;
  return subtotal + tax + shipping;
}
`;
const TS_COMMENTED = `export function calculateOrderTotal(items: number[]): number {
  // Sum first, then apply GST.
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const tax = subtotal * 0.18; /* GST rate */
  const shipping = subtotal > 1000 ? 0 : 75;
  return subtotal + tax + shipping;
}
`;
const TS_CODE_CHANGED = TS.replace("subtotal * 0.18", "subtotal * 0.21");
const TS_BOTH = TS_COMMENTED.replace("subtotal * 0.18", "subtotal * 0.21");

const PY = `def order_total(items):
    """Sum the items and add tax."""
    subtotal = sum(items)
    tax = subtotal * 0.18
    return subtotal + tax
`;
const PY_COMMENTED = `def order_total(items):
    """Sum the items and add tax."""
    # GST applies to everything.
    subtotal = sum(items)
    tax = subtotal * 0.18  # rate
    return subtotal + tax
`;
const PY_DOCSTRING = PY.replace("Sum the items and add tax.", "Sum the items and add GST.");

interface Fixture {
  root: string;
  source: string;
  scaffold: string;
  config: MexConfig;
}

function fixture(file: "src/service.ts" | "src/service.py", body: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mex-comment-drift-"));
  roots.push(root);
  const source = join(root, file);
  const scaffold = join(root, ".mex", "context", "architecture.md");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  // A scaffold with nothing else to report, so `mex sync` sees only the
  // grounding under test.
  writeFileSync(join(root, "CLAUDE.md"), "Read `.mex/ROUTER.md` before starting.\n");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(scaffold, `---\nname: architecture\ndescription: Order totals.\nlast_updated: ${today}\n---\n\n# Architecture\n`);
  writeFileSync(source, body);
  return { root, source, scaffold, config: { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: ["claude"] } };
}

async function buildGraph(root: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}

/** Delete the disposable index, cache included, and build it again. */
async function rebuildGraphFromScratch(root: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, ".mex", `graph.db${suffix}`), { force: true });
  await buildGraph(root);
}

/** Ground the symbol the way an agent does: id and fingerprint only. */
async function authorGrounding(config: MexConfig, scaffold: string, symbol: string): Promise<string> {
  const runtime = await loadGroundingRuntime(config);
  try {
    const node = runtime!.graph.searchNodes(symbol).find((entry) => entry.kind === "function")!;
    const fingerprint = runtime!.reconciler.getFingerprint(node.id)!;
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: node.id,
      fingerprint: serializeFingerprint(fingerprint),
    }]));
    return node.id;
  } finally {
    runtime!.close();
  }
}

async function capture(config: MexConfig, scaffold: string): Promise<void> {
  const runtime = await loadGroundingRuntime(config);
  try {
    refreshGroundingBaselines(config, [scaffold], runtime!);
  } finally {
    runtime!.close();
  }
}

async function groundingIssues(config: MexConfig): Promise<Array<{ code: string; severity: string }>> {
  const report = await runDriftCheckWithGraphStatus(config, { graphWarning: () => {} });
  return report.issues
    .filter((issue) => issue.code.startsWith("GROUNDING_"))
    .map((issue) => ({ code: issue.code, severity: issue.severity }));
}

/** A grounded fixture whose baseline, including `codeHash`, is committed. */
async function grounded(file: "src/service.ts" | "src/service.py", body: string, symbol: string): Promise<Fixture> {
  const fx = fixture(file, body);
  await buildGraph(fx.root);
  await authorGrounding(fx.config, fx.scaffold, symbol);
  await capture(fx.config, fx.scaffold);
  return fx;
}

describe("comment-only changes to grounded code (#236)", () => {
  it("captures codeHash beside bodyHash, bound to it", async () => {
    const fx = await grounded("src/service.ts", TS, "calculateOrderTotal");
    const [entry] = extractGroundings(readFileSync(fx.scaffold, "utf-8"));
    expect(entry!.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry!.codeHash).toMatch(/^ch1:[0-9a-f]{12}:[0-9a-f]{64}$/);
    expect(entry!.codeHash!.split(":")[1]).toBe(entry!.bodyHash!.slice(0, 12));
    expect(await groundingIssues(fx.config)).toEqual([]);
  }, 60_000);

  it("ignores a code hash left beside a bodyHash it was not captured with", async () => {
    // What an older version's accepted review, or a hand edit, leaves behind:
    // a renewed bodyHash next to the previous code hash. The pair no longer
    // describes one moment, so it must not vouch for anything.
    const fx = await grounded("src/service.ts", TS, "calculateOrderTotal");
    const [entry] = extractGroundings(readFileSync(fx.scaffold, "utf-8"));
    writeFileSync(fx.scaffold, writeGroundings(readFileSync(fx.scaffold, "utf-8"), [{ ...entry!, bodyHash: "0".repeat(64) }]));
    // Only comments changed; but with the pair unbound, nothing can say so.
    writeFileSync(fx.source, TS_COMMENTED);
    await rebuildGraphFromScratch(fx.root);
    expect(await groundingIssues(fx.config)).toEqual([{ code: "GROUNDING_DRIFT", severity: "warning" }]);
  }, 60_000);

  it("reports a comment-only edit as an unscored notice, and code edits as drift", async () => {
    const cases: Array<[string, string, string]> = [
      [TS_COMMENTED, "GROUNDING_COMMENT_DRIFT", "info"],
      [TS_CODE_CHANGED, "GROUNDING_DRIFT", "warning"],
      [TS_BOTH, "GROUNDING_DRIFT", "warning"],
    ];
    for (const [edit, code, severity] of cases) {
      const fx = await grounded("src/service.ts", TS, "calculateOrderTotal");
      writeFileSync(fx.source, edit);
      await rebuildGraphFromScratch(fx.root);
      const issues = await groundingIssues(fx.config);
      expect(issues).toEqual([{ code, severity }]);
    }
    expect(computeScore([{ code: "GROUNDING_COMMENT_DRIFT", severity: "info", file: "x", line: null, message: "" }])).toBe(100);
  }, 180_000);

  it("reads a Python comment as a comment and a docstring as code", async () => {
    for (const [edit, code] of [[PY_COMMENTED, "GROUNDING_COMMENT_DRIFT"], [PY_DOCSTRING, "GROUNDING_DRIFT"]] as const) {
      const fx = await grounded("src/service.py", PY, "order_total");
      writeFileSync(fx.source, edit);
      await rebuildGraphFromScratch(fx.root);
      expect((await groundingIssues(fx.config)).map((issue) => issue.code)).toEqual([code]);
    }
  }, 120_000);

  it("answers without a refresh when only source changed, by re-reading the edited file", async () => {
    const fx = await grounded("src/service.py", PY, "order_total");
    writeFileSync(fx.source, PY_COMMENTED);
    // No rebuild: the graph is stale only by changed source (#228).
    expect((await groundingIssues(fx.config)).map((issue) => issue.code)).toEqual(["GROUNDING_COMMENT_DRIFT"]);
  }, 60_000);

  it("falls back to the cached old body for a grounding without codeHash, and to the warning without it", async () => {
    const fx = await grounded("src/service.ts", TS, "calculateOrderTotal");
    // A grounding committed before codeHash existed.
    const [entry] = extractGroundings(readFileSync(fx.scaffold, "utf-8"));
    delete entry!.codeHash;
    writeFileSync(fx.scaffold, writeGroundings(readFileSync(fx.scaffold, "utf-8"), [entry!]));
    expect(extractGroundings(readFileSync(fx.scaffold, "utf-8"))[0]!.codeHash).toBeUndefined();

    writeFileSync(fx.source, TS_COMMENTED);
    const engine = createGraphEngine({ rootDir: fx.root });
    await engine.sync(["src/service.ts"]);
    engine.close();
    expect((await groundingIssues(fx.config)).map((issue) => issue.code)).toEqual(["GROUNDING_COMMENT_DRIFT"]);

    // The cache is disposable: once it is gone nothing can vouch for the old
    // body, so the change stays a warning rather than being guessed down.
    await rebuildGraphFromScratch(fx.root);
    expect((await groundingIssues(fx.config)).map((issue) => issue.code)).toEqual(["GROUNDING_DRIFT"]);
  }, 120_000);

  it("offers the review instead of an AI session, and accepting renews both hashes", async () => {
    const fx = await grounded("src/service.ts", TS, "calculateOrderTotal");
    const before = extractGroundings(readFileSync(fx.scaffold, "utf-8"))[0]!;
    writeFileSync(fx.source, TS_COMMENTED);
    await rebuildGraphFromScratch(fx.root);

    const runAgent = vi.fn(() => true);
    const answers = ["y", "y"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runSync(fx.config, {}, { ask: async () => answers.shift() ?? "n", runAgent, reviewGrounding: true });

    expect(runAgent).not.toHaveBeenCalled();
    const after = extractGroundings(readFileSync(fx.scaffold, "utf-8"))[0]!;
    expect(after.bodyHash).not.toBe(before.bodyHash);
    // The code did not change, so its comment-free hash did not either; only
    // the binding moved to the renewed body hash.
    expect(after.codeHash!.split(":")[2]).toBe(before.codeHash!.split(":")[2]);
    expect(after.codeHash!.split(":")[1]).toBe(after.bodyHash!.slice(0, 12));
    expect(await groundingIssues(fx.config)).toEqual([]);
  }, 120_000);
});
