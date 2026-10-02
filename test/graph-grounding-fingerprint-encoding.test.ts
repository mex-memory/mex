/**
 * A scaffold committed with `mh:` hex fingerprints, read by a graph that now
 * serializes `mh2:` (#233).
 *
 * The two encodings are one fingerprint in two spellings. Everything that used
 * to compare the strings — capture, the sync review, `check`, the wiki's
 * resolution and its store merge — has to see that, or every grounding written
 * before the upgrade reads as changed code nobody touched.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MexConfig } from "../src/types.js";
import { resolveAnchorBaseline } from "../src/drift/checkers/grounding.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { codeHash, formatCommittedCodeHash } from "../src/graph/code-hash.js";
import { deserializeFingerprint, serializeFingerprint } from "../src/graph/fingerprint.js";
import type { Fingerprint } from "../src/graph/reconcile.js";
import { loadGroundingRuntime, previewGroundingBaseline, refreshGroundingBaselines } from "../src/graph/runtime.js";
import { extractGroundings } from "../src/markdown.js";
import { resolveGrounding } from "../src/wiki/grounding/resolve.js";
import { mergeGroundingStores } from "../src/wiki/markdown/grounding-stores.js";

const roots: string[] = [];

const SOURCE = `export function calculateOrderTotal(items: number[]): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const tax = subtotal * 0.18;
  const shipping = subtotal > 1000 ? 0 : 75;
  const discount = items.length > 5 ? subtotal * 0.05 : 0;
  return subtotal + tax + shipping - discount;
}
`;

/** The encoding every scaffold committed before #233. */
function hexEncoded(fingerprint: Fingerprint): string {
  return `mh:64:${Buffer.from(JSON.stringify(fingerprint), "utf8").toString("hex")}`;
}

interface Fixture {
  root: string;
  source: string;
  scaffold: string;
  scaffoldFile: string;
  config: MexConfig;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mex-fingerprint-encoding-"));
  roots.push(root);
  const source = join(root, "src", "service.ts");
  const scaffold = join(root, ".mex", "context", "architecture.md");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(scaffold, "---\nname: architecture\n---\n\n# Architecture\n");
  writeFileSync(source, SOURCE);
  return {
    root,
    source,
    scaffold,
    scaffoldFile: ".mex/context/architecture.md",
    config: { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] },
  };
}

async function buildGraph(root: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}

/** The node's id, current fingerprint, body hash and committed code hash, as the graph produces them. */
async function graphFacts(
  config: MexConfig,
): Promise<{ node: string; fingerprint: Fingerprint; bodyHash: string; codeHash: string }> {
  const runtime = await loadGroundingRuntime(config);
  try {
    const found = runtime!.graph.searchNodes("calculateOrderTotal").find((entry) => entry.kind === "function")!;
    const node = runtime!.graph.getNode(found.id)!;
    // The committed code hash (#236), as capture would write it.
    const source = readFileSync(join(config.projectRoot, node.filePath), "utf-8");
    const code = codeHash(node.filePath, source, node.startLine, node.endLine)!;
    return {
      node: node.id,
      fingerprint: runtime!.reconciler.getFingerprint(node.id)!,
      bodyHash: node.bodyHash!,
      codeHash: formatCommittedCodeHash(code, node.bodyHash!),
    };
  } finally {
    runtime!.close();
  }
}

/** A grounding as a pre-#233 scaffold committed it, written as text so no writer re-encodes it. */
function commitHexGrounding(
  scaffold: string,
  node: string,
  fingerprint: string,
  bodyHash?: string,
  codeHashValue?: string,
): string {
  const content = [
    "---",
    "name: architecture",
    "grounds_to:",
    `  - node: "${node}"`,
    `    fingerprint: "${fingerprint}"`,
    ...(bodyHash === undefined ? [] : [`    bodyHash: "${bodyHash}"`]),
    ...(codeHashValue === undefined ? [] : [`    codeHash: "${codeHashValue}"`]),
    "---",
    "",
    "# Architecture",
    "",
  ].join("\n");
  writeFileSync(scaffold, content);
  return content;
}

async function groundingIssueCodes(config: MexConfig): Promise<string[]> {
  const report = await runDriftCheckWithGraphStatus(config, { graphWarning: () => {} });
  expect(report.graphStatus?.status).toBe("fresh");
  return report.issues.filter((issue) => issue.code.startsWith("GROUNDING_")).map((issue) => issue.code);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a scaffold committed with hex fingerprints (#233)", () => {
  it("is clean, needs no review, and is left byte-for-byte alone", async () => {
    const { root, scaffold, scaffoldFile, config } = fixture();
    await buildGraph(root);
    const facts = await graphFacts(config);
    // Complete as a current scaffold commits it, so the encoding is the only
    // difference from what the graph writes now.
    const committed = commitHexGrounding(scaffold, facts.node, hexEncoded(facts.fingerprint), facts.bodyHash, facts.codeHash);

    expect(await groundingIssueCodes(config)).toEqual([]);

    const runtime = await loadGroundingRuntime(config);
    try {
      // Nothing changed, so there is nothing to review.
      expect(previewGroundingBaseline(config, scaffoldFile, facts.node, runtime!)).toBeNull();
      // Capture accepts it as the unchanged grounding it is, and has no reason to write.
      const warnings: string[] = [];
      const result = refreshGroundingBaselines(config, [scaffold], runtime!, { warn: (m) => warnings.push(m) });
      expect(warnings).toEqual([]);
      expect(result).toEqual({ captured: 1, skipped: 0 });
    } finally {
      runtime!.close();
    }
    expect(readFileSync(scaffold, "utf-8")).toBe(committed);
  }, 60_000);

  it("still reports drift when the code under it changes", async () => {
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    const facts = await graphFacts(config);
    commitHexGrounding(scaffold, facts.node, hexEncoded(facts.fingerprint), facts.bodyHash);

    writeFileSync(source, SOURCE.replace("subtotal * 0.18", "subtotal * 0.21"));
    await buildGraph(root);
    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("is re-encoded, value for value, only when its groundings are being rewritten", async () => {
    const { root, scaffold, config } = fixture();
    await buildGraph(root);
    const facts = await graphFacts(config);
    // No body hash yet: capture has to backfill one, which rewrites the groundings.
    commitHexGrounding(scaffold, facts.node, hexEncoded(facts.fingerprint));

    const runtime = await loadGroundingRuntime(config);
    try {
      refreshGroundingBaselines(config, [scaffold], runtime!);
    } finally {
      runtime!.close();
    }
    const [written] = extractGroundings(readFileSync(scaffold, "utf-8"));
    expect(written!.bodyHash).toBe(facts.bodyHash);
    expect(written!.fingerprint).toBe(serializeFingerprint(facts.fingerprint));
    expect(deserializeFingerprint(written!.fingerprint)).toEqual(facts.fingerprint);
    expect(await groundingIssueCodes(config)).toEqual([]);
  }, 60_000);
});

describe("comparing one fingerprint in two encodings", () => {
  const fingerprint: Fingerprint = {
    minhash: Array.from({ length: 64 }, (_, index) => index * 65_537),
    neighbors: ["function:0123456789abcdef0123456789abcdef"],
    tokenCount: 40,
  };
  const compact = serializeFingerprint(fingerprint);
  const hex = hexEncoded(fingerprint);
  const node = "function:fedcba9876543210fedcba9876543210";

  it("resolves fresh in the wiki when only the committed fingerprint can decide", () => {
    const graph = {
      getNode: () => ({ id: node, bodyHash: "body", filePath: "src/a.ts", startLine: 1, endLine: 2 }),
      getFingerprint: () => compact,
      reconcile: () => ({ kind: "GONE" as const }),
      getBaselineSource: () => null,
    };
    expect(resolveGrounding({ node, fingerprint: hex }, graph)).toMatchObject({ state: "fresh", health: "fresh" });
  });

  it("is not a conflict between the root and mex stores", () => {
    const stores = mergeGroundingStores([{ node, fingerprint: compact }], [{ node, fingerprint: hex }]);
    expect(stores.conflicts).toEqual([]);
  });

  it("is not a conflict between two scaffold files an anchor could take its baseline from", () => {
    const baseline = resolveAnchorBaseline({
      current: null,
      here: undefined,
      elsewhere: () => [
        { file: ".mex/context/a.md", node, fingerprint: hex },
        { file: ".mex/context/b.md", node, fingerprint: compact },
      ],
      cached: null,
    });
    expect(baseline).not.toBe("conflict");
    expect(baseline).toMatchObject({ fingerprint });
  });
});
