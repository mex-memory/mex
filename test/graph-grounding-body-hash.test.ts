/**
 * The grounding change signal has to survive `mex graph rebuild`.
 *
 * `.mex/graph.db` is gitignored and disposable by invariant, and the product
 * offers a rebuild as a routine repair. A drift baseline held only in that file
 * is therefore gone whenever a user takes the repair the product recommends,
 * and it never existed at all for a teammate who cloned. These tests delete the
 * index and rebuild it — the exact thing that used to destroy the baseline —
 * and assert that drift is still detected afterwards.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { captureGroundingBaselines, loadGroundingRuntime, persistMovedGroundings, previewGroundingBaseline, refreshGroundingBaselines } from "../src/graph/runtime.js";
import { runSync, reviewGroundingBaselines } from "../src/sync/index.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";

const roots: string[] = [];

vi.mock("../src/cli-tools.js", () => ({ isCliAvailable: () => true }));

/** The body an agent grounds to, and the one-constant edit that drifts it. */
const ORIGINAL = `export function calculateOrderTotal(items: number[]): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const tax = subtotal * 0.18;
  const shipping = subtotal > 1000 ? 0 : 75;
  const discount = items.length > 5 ? subtotal * 0.05 : 0;
  return subtotal + tax + shipping - discount;
}
`;
const EDITED = ORIGINAL.replace("subtotal * 0.18", "subtotal * 0.21");

function fixture(): { root: string; source: string; scaffold: string; config: MexConfig } {
  const root = mkdtempSync(join(tmpdir(), "mex-grounding-body-hash-"));
  roots.push(root);
  const source = join(root, "src", "service.ts");
  const scaffold = join(root, ".mex", "context", "architecture.md");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(scaffold, "---\nname: architecture\n---\n\n# Architecture\n");
  writeFileSync(source, ORIGINAL);
  return { root, source, scaffold, config: { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] } };
}

async function buildGraph(root: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}

/**
 * Author a grounding the way `mex ground` does: an agent copies the node id and
 * the fingerprint out of graph output and writes nothing else. There is no body
 * hash at this point, because the agent was never given one — which is why the
 * capture pass below is the thing that has to supply it.
 */
async function authorGrounding(
  config: MexConfig,
  scaffold: string,
  symbol: string,
  extra: { bodyHash?: string } = {},
): Promise<string> {
  const runtime = await loadGroundingRuntime(config);
  try {
    const node = runtime!.graph.searchNodes(symbol).find((entry) => entry.kind === "function")!;
    const fingerprint = runtime!.reconciler.getFingerprint(node.id)!;
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: node.id,
      fingerprint: serializeFingerprint(fingerprint),
      ...extra,
    }]));
    return node.id;
  } finally {
    runtime!.close();
  }
}

/** Every default caller initializes missing baselines but preserves accepted ones. */
async function captureBaselines(config: MexConfig, scaffold: string): Promise<void> {
  const runtime = await loadGroundingRuntime(config);
  try {
    refreshGroundingBaselines(config, [scaffold], runtime!);
  } finally {
    runtime!.close();
  }
}

/** Delete the disposable index and rebuild it, as `mex graph rebuild` does. */
async function rebuildGraphFromScratch(root: string): Promise<void> {
  rmSync(join(root, ".mex", "graph.db"), { force: true });
  rmSync(join(root, ".mex", "graph.db-wal"), { force: true });
  rmSync(join(root, ".mex", "graph.db-shm"), { force: true });
  await buildGraph(root);
}

async function groundingIssueCodes(config: MexConfig): Promise<string[]> {
  const report = await runDriftCheckWithGraphStatus(config, { graphWarning: () => {} });
  expect(report.graphStatus?.status).toBe("fresh");
  return report.issues.filter((issue) => issue.code.startsWith("GROUNDING_")).map((issue) => issue.code);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the grounding body hash is committed to Markdown", () => {
  it("captures it into the scaffold, so drift survives deleting and rebuilding graph.db", async () => {
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");

    // What the agent wrote: identity only, no change signal anywhere in Git.
    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBeUndefined();

    await captureBaselines(config, scaffold);
    const committed = extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash;
    expect(committed).toBeTypeOf("string");
    expect(committed!.length).toBeGreaterThan(0);

    // The value is the graph's, not an invention of the writer.
    const runtime = await loadGroundingRuntime(config);
    const node = runtime!.graph.getNode(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.node)!;
    expect(committed).toBe(node.bodyHash);
    runtime!.close();

    // The move that used to destroy the baseline, and is offered as a repair.
    writeFileSync(source, EDITED);
    await rebuildGraphFromScratch(root);

    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("says a grounding has no baseline after the same rebuild when the scaffold carries no hash", async () => {
    // The pre-fix world, reproduced deliberately. A grounding with no committed
    // hash parses and resolves without a crash or a false drift, and cannot
    // detect the edit either, so it is reported as having no baseline.
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");
    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBeUndefined();

    writeFileSync(source, EDITED);
    await rebuildGraphFromScratch(root);

    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_NO_BASELINE"]);
  }, 60_000);

  it("never passes an old grounding with no body hash clean, and never takes the cache as its baseline", async () => {
    // A scaffold authored before this field existed. `check` and the Wiki share
    // one verdict, and the Wiki never takes the graph.db cache as the oracle,
    // so the link is compared by structure, which cannot see an edited
    // constant. It is reported as having no baseline instead of passing.
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");
    await captureBaselines(config, scaffold);

    // Strip the field back out, leaving the graph.db row in place.
    const stripped = extractGroundings(readFileSync(scaffold, "utf-8"))
      .map(({ node, fingerprint }) => ({ node, fingerprint }));
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), stripped));
    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBeUndefined();

    writeFileSync(source, EDITED);
    await buildGraph(root);

    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_NO_BASELINE"]);
  }, 60_000);

  it("backfills a migrated file-level entity, whose grounding lives under the mex map", async () => {
    // The population that surfaced this: a scaffold `wiki migrate` has adopted
    // keeps its groundings under `mex.grounds_to` rather than at the root, and
    // migration's own `backfill` only adds a body hash when it is handed a
    // graph — which the wiki CLI does not do. So the capture pass has to reach
    // this shape too, and it has to splice the one key without disturbing the
    // rest of the map.
    const { root, source, scaffold, config } = fixture();
    writeFileSync(
      scaffold,
      "---\nname: architecture\nmex:\n  id: mx_01ARZ3NDEKTSV4RRFFQ69G5FAA\n  type: pattern\n---\n\n# Architecture\n",
    );
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");
    await captureBaselines(config, scaffold);

    const after = readFileSync(scaffold, "utf-8");
    expect(after).toContain("mex:");
    expect(after).toContain("id: mx_01ARZ3NDEKTSV4RRFFQ69G5FAA");
    expect(extractGroundings(after)[0]!.bodyHash).toBeTypeOf("string");

    writeFileSync(source, EDITED);
    await rebuildGraphFromScratch(root);
    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("does not overwrite a committed hash that has drifted, which would erase the finding", async () => {
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");
    await captureBaselines(config, scaffold);
    const baseline = extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash!;

    // Edit the body without touching its structure enough to move the
    // fingerprint, then run the capture pass again. A pass that re-baselined
    // unconditionally would silently adopt the new body as the truth.
    writeFileSync(source, EDITED);
    await buildGraph(root);
    await captureBaselines(config, scaffold);

    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBe(baseline);
    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);
});

describe("grounding renewal requires an exact reviewed entry", () => {
  async function ready() {
    const target = fixture();
    await buildGraph(target.root);
    const nodeId = await authorGrounding(target.config, target.scaffold, "calculateOrderTotal");
    await captureBaselines(target.config, target.scaffold);
    const runtime = await loadGroundingRuntime(target.config);
    const baseline = runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)!;
    runtime!.close();
    return { ...target, nodeId, baseline };
  }

  it("a successful no-op agent session preserves drift, canonical bytes, and cached old code", async () => {
    const { config, source, scaffold, nodeId, baseline } = await ready();
    const before = readFileSync(scaffold, "utf-8");
    writeFileSync(source, EDITED);
    const runAgent = vi.fn(() => true);
    const answers = ["1", "n"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync({ ...config, aiTools: ["claude"] }, {}, {
      runAgent,
      ask: async () => answers.shift() ?? "n",
      reviewGrounding: false,
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(readFileSync(scaffold, "utf-8")).toBe(before);
    const runtime = await loadGroundingRuntime(config);
    expect(runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)).toEqual(baseline);
    runtime!.close();
    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("backfills legacy Markdown from its old cache after a literal-only edit and survives rebuild", async () => {
    const { config, root, source, scaffold, nodeId, baseline } = await ready();
    const stripped = extractGroundings(readFileSync(scaffold, "utf-8"))
      .map(({ node, fingerprint }) => ({ node, fingerprint }));
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), stripped));
    writeFileSync(source, EDITED);
    const result = await captureGroundingBaselines(config);
    expect(result).toEqual({ captured: 0, skipped: 1 });
    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBe(baseline.bodyHash);
    const runtime = await loadGroundingRuntime(config);
    expect(runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)).toEqual(baseline);
    runtime!.close();
    await rebuildGraphFromScratch(root);
    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("accepts only the selected document entry and leaves another grounding drifted across rebuild", async () => {
    const { config, root, source, scaffold, nodeId } = await ready();
    const other = join(root, ".mex", "context", "other.md");
    writeFileSync(other, readFileSync(scaffold));
    await captureGroundingBaselines(config);
    const otherBefore = readFileSync(other, "utf-8");
    writeFileSync(source, EDITED);
    const runtime = await loadGroundingRuntime(config);
    const review = previewGroundingBaseline(config, ".mex/context/architecture.md", nodeId, runtime!)!;
    const otherBaseline = runtime!.fingerprints.getGroundedSource(".mex/context/other.md", nodeId);
    runtime!.close();
    expect(review.oldBody).toContain("subtotal * 0.18");
    expect(review.newBody).toContain("subtotal * 0.21");
    expect(await captureGroundingBaselines(config, { acceptedGroundings: [review.acceptance] }))
      .toEqual({ captured: 1, skipped: 0 });
    expect(readFileSync(other, "utf-8")).toBe(otherBefore);
    const after = await loadGroundingRuntime(config);
    expect(after!.fingerprints.getGroundedSource(".mex/context/other.md", nodeId)).toEqual(otherBaseline);
    after!.close();
    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBe(review.acceptance.bodyHash);
    await rebuildGraphFromScratch(root);
    const report = await runDriftCheckWithGraphStatus(config);
    expect(report.issues.filter((entry) => entry.code === "GROUNDING_DRIFT"))
      .toMatchObject([{ file: ".mex/context/other.md" }]);
  }, 60_000);

  it.each(["document", "source"] as const)("rejects acceptance when the %s changes after preview", async (changed) => {
    const { config, source, scaffold, nodeId, baseline } = await ready();
    writeFileSync(source, EDITED);
    const runtime = await loadGroundingRuntime(config);
    const acceptance = previewGroundingBaseline(config, ".mex/context/architecture.md", nodeId, runtime!)!.acceptance;
    runtime!.close();
    if (changed === "document") writeFileSync(scaffold, readFileSync(scaffold, "utf-8") + "\nConcurrent clarification.\n");
    else writeFileSync(source, EDITED.replace("subtotal * 0.21", "subtotal * 0.25"));
    const before = readFileSync(scaffold, "utf-8");
    expect(await captureGroundingBaselines(config, { acceptedGroundings: [acceptance] }))
      .toEqual({ captured: 0, skipped: 1 });
    expect(readFileSync(scaffold, "utf-8")).toBe(before);
    const after = await loadGroundingRuntime(config);
    expect(after!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)).toEqual(baseline);
    after!.close();
  }, 60_000);

  it("preserves a concurrent document edit and the old cache during acceptance preparation", async () => {
    const { config, source, scaffold, nodeId, baseline } = await ready();
    writeFileSync(source, EDITED);
    const runtime = await loadGroundingRuntime(config);
    try {
      const acceptance = previewGroundingBaseline(config, ".mex/context/architecture.md", nodeId, runtime!)!.acceptance;
      const concurrent = readFileSync(scaffold, "utf-8") + "\nConcurrent clarification.\n";
      const getNode = runtime!.graph.getNode.bind(runtime!.graph);
      let reads = 0;
      vi.spyOn(runtime!.graph, "getNode").mockImplementation((id) => {
        if (++reads === 2) writeFileSync(scaffold, concurrent);
        return getNode(id);
      });
      expect(refreshGroundingBaselines(config, [scaffold], runtime!, { acceptedGroundings: [acceptance] }))
        .toEqual({ captured: 0, skipped: 1 });
      expect(readFileSync(scaffold, "utf-8")).toBe(concurrent);
      expect(runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)).toEqual(baseline);
    } finally {
      runtime!.close();
    }
  }, 60_000);

  it("keeps MOVED content drift and historical cache after rebinding a legacy grounding", async () => {
    const { config, root, source, scaffold, nodeId, baseline } = await ready();
    const stripped = extractGroundings(readFileSync(scaffold, "utf-8"))
      .map(({ node, fingerprint }) => ({ node, fingerprint }));
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), stripped));
    writeFileSync(source, EDITED.replace("calculateOrderTotal", "computeOrderTotal"));
    const runtime = await loadGroundingRuntime(config);
    expect(persistMovedGroundings(config, [scaffold], runtime!)).toBe(1);
    const moved = extractGroundings(readFileSync(scaffold, "utf-8"))[0]!;
    expect(moved.node).not.toBe(nodeId);
    expect(moved.bodyHash).toBe(baseline.bodyHash);
    expect(runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", moved.node))
      .toEqual({ ...baseline, nodeId: moved.node });
    runtime!.close();
    await rebuildGraphFromScratch(root);
    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("preserves canonical destination evidence when a MOVED pointer would collide", async () => {
    const { config, source, scaffold, nodeId, baseline } = await ready();
    writeFileSync(source, EDITED.replace("calculateOrderTotal", "computeOrderTotal"));
    const runtime = await loadGroundingRuntime(config);
    try {
      const current = runtime!.graph.searchNodes("computeOrderTotal").find((entry) => entry.kind === "function")!;
      const currentFingerprint = serializeFingerprint(runtime!.reconciler.getFingerprint(current.id)!);
      const original = extractGroundings(readFileSync(scaffold, "utf-8"))[0]!;
      const destination = { ...baseline, nodeId: current.id, source: EDITED.replace("calculateOrderTotal", "computeOrderTotal").trimEnd(), bodyHash: current.bodyHash!, fingerprint: currentFingerprint };
      runtime!.fingerprints.saveGroundedSource(destination);
      writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [original, {
        node: current.id, fingerprint: currentFingerprint, bodyHash: current.bodyHash,
      }]) + `\n[Old name](mex://${nodeId})\n`);
      expect(persistMovedGroundings(config, [scaffold], runtime!)).toBe(1);
      expect(extractGroundings(readFileSync(scaffold, "utf-8")).map((entry) => entry.node)).toEqual([nodeId, current.id]);
      expect(runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", current.id)).toEqual(destination);
      expect(runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)).toEqual(baseline);
    } finally {
      runtime!.close();
    }
  }, 60_000);

  it("retains the old MOVED cache when the document changes before pointer publication", async () => {
    const { config, source, scaffold, nodeId, baseline } = await ready();
    writeFileSync(source, EDITED.replace("calculateOrderTotal", "computeOrderTotal"));
    const runtime = await loadGroundingRuntime(config);
    try {
      const concurrent = readFileSync(scaffold, "utf-8") + "\nConcurrent clarification.\n";
      const getNode = runtime!.graph.getNode.bind(runtime!.graph);
      vi.spyOn(runtime!.graph, "getNode").mockImplementationOnce((id) => {
        writeFileSync(scaffold, concurrent);
        return getNode(id);
      });
      expect(() => persistMovedGroundings(config, [scaffold], runtime!)).toThrow("changed before publication");
      expect(readFileSync(scaffold, "utf-8")).toBe(concurrent);
      expect(runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)).toEqual(baseline);
    } finally {
      runtime!.close();
    }
  }, 60_000);

  it.each(["oversized", "invalid-utf8"] as const)("rejects an %s accepted document without changing the old cache", async (kind) => {
    const { config, source, scaffold, nodeId, baseline } = await ready();
    writeFileSync(source, EDITED);
    const runtime = await loadGroundingRuntime(config);
    try {
      const acceptance = previewGroundingBaseline(config, ".mex/context/architecture.md", nodeId, runtime!)!.acceptance;
      const changed = Buffer.concat([readFileSync(scaffold), kind === "oversized" ? Buffer.alloc(64 * 1024, 32) : Buffer.from([0xff])]);
      writeFileSync(scaffold, changed);
      expect(() => refreshGroundingBaselines(config, [scaffold], runtime!, { acceptedGroundings: [acceptance] })).toThrow();
      expect(readFileSync(scaffold)).toEqual(changed);
      expect(runtime!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)).toEqual(baseline);
    } finally {
      runtime!.close();
    }
  }, 60_000);

  it("reviews default-no and then accepts one entry without holding a graph lease across input", async () => {
    const { config, source, scaffold, nodeId, baseline } = await ready();
    writeFileSync(source, EDITED);
    const targets = [{ file: ".mex/context/architecture.md", gitDiff: null, issues: [{
      code: "GROUNDING_DRIFT" as const, severity: "warning" as const, file: ".mex/context/architecture.md", line: null, message: `Grounded node body changed: ${nodeId}`,
    }] }];
    const before = readFileSync(scaffold, "utf-8");
    await reviewGroundingBaselines(config, targets, async () => "", () => {});
    expect(readFileSync(scaffold, "utf-8")).toBe(before);
    const messages: string[] = [];
    await reviewGroundingBaselines(config, targets, async () => {
      const whilePrompting = await loadGroundingRuntime(config);
      expect(whilePrompting!.fingerprints.getGroundedSource(".mex/context/architecture.md", nodeId)).toEqual(baseline);
      whilePrompting!.close();
      return "yes";
    }, (message) => messages.push(message));
    expect(messages.join("\n")).toContain("Previously accepted code:");
    expect(messages.join("\n")).toContain("grounding metadata hidden");
    expect(messages.join("\n")).not.toContain(baseline.fingerprint);
    expect(messages.join("\n")).toContain("name: architecture");
    expect(messages.join("\n")).toContain("subtotal * 0.18");
    expect(messages.join("\n")).toContain("subtotal * 0.21");
    expect(await groundingIssueCodes(config)).toEqual([]);
  }, 60_000);

  it("does not label an unrelated cached body as the canonically accepted code", async () => {
    const { config, source, scaffold, nodeId } = await ready();
    const groundings = extractGroundings(readFileSync(scaffold, "utf-8"));
    groundings[0]!.bodyHash = "a".repeat(64);
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), groundings));
    writeFileSync(source, EDITED);
    const runtime = await loadGroundingRuntime(config);
    expect(previewGroundingBaseline(config, ".mex/context/architecture.md", nodeId, runtime!)!.oldBody).toBeNull();
    runtime!.close();
  }, 60_000);
});
