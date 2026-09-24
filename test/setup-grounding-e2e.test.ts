import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExistingNoBriefPrompt,
  buildExistingWithBriefPrompt,
  buildFreshPrompt,
} from "../src/setup/prompts.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { runGraphScope } from "../src/graph/cli-agent.js";
import { deserializeFingerprint } from "../src/graph/fingerprint.js";
import { extractGroundings, findMexAnchors, writeGroundings } from "../src/markdown.js";
import { checkBrokenLinks } from "../src/drift/checkers/broken-link.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { captureGroundingBaselines, loadGroundingRuntime, previewGroundingBaseline } from "../src/graph/runtime.js";
import { finalizeSetupWiki } from "../src/setup/wiki-finalize.js";
import { finalizeCodeRepoSetup, SetupFinalizationError } from "../src/setup/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup graph-grounding population", () => {
  it("directs both existing-project paths through broad graph reads and tight grounding", () => {
    for (const prompt of [buildExistingWithBriefPrompt('{"folders":["src"]}'), buildExistingNoBriefPrompt()]) {
      expect(prompt).toContain('mex graph scope "<task or domain>"');
      expect(prompt).toContain("READ BROAD, GROUND TIGHT");
      expect(prompt).toContain('fingerprint: "<exact fingerprint from the same graph fact>"');
      expect(prompt).toContain("mex://<exact-node-id>");
      expect(prompt).toContain("Never ground every node returned by scope");
      expect(prompt).toContain("architecture/stack/conventions files should ground sparsely");
      expect(prompt).toContain("Pattern files and deep domain files should ground tightly");
      expect(prompt).toContain("use that exact launcher consistently");
      expect(prompt).toContain("node dist/cli.js");
      expect(prompt).toContain("Treat substantive existing content as durable project knowledge");
      expect(prompt).toContain("managed instruction blocks");
      expect(prompt).toMatch(/every existing project pattern/iu);
      expect(prompt).toMatch(/do not\s+duplicate, delete, or rename a pattern/iu);
      expect(prompt).toContain("Edge targets are relative to the .mex/ scaffold root");
      expect(prompt).not.toContain("Read 2-3 representative files");
      // Agents are told to retain this rule in AGENTS.md; a verbatim copy must
      // not leave a placeholder link that setup then verifies against the graph.
      expect(findMexAnchors(prompt)).toEqual([]);
    }
  });

  it("names an unverifiable placeholder anchor in a safe finalization failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-setup-placeholder-"));
    roots.push(root);
    const scaffoldRoot = join(root, ".mex");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(scaffoldRoot, { recursive: true });
    writeFileSync(join(root, "src", "service.ts"), "export function liveService(): number { return 1; }\n");
    writeFileSync(join(scaffoldRoot, "AGENTS.md"),
      "# Agents\n\nAnchor symbols inline as [`symbolName()`](mex://<exact-node-id>) with the node id only.\n");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    const failure = await finalizeCodeRepoSetup(root, scaffoldRoot).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SetupFinalizationError);
    expect((failure as Error).message).toContain("<exact-node-id> in .mex/AGENTS.md");
    expect((failure as Error).message.length).toBeLessThanOrEqual(512);
  }, 30_000);

  it("preserves authored scaffold content when a fresh project resumes setup", () => {
    const prompt = buildFreshPrompt();
    expect(prompt).toContain("Treat substantive existing content as durable project knowledge");
    expect(prompt).toContain("managed instruction blocks");
    expect(prompt).toMatch(/every existing project pattern/iu);
    expect(prompt).toMatch(/never duplicate,\s+delete, or rename a pattern/iu);
    expect(prompt).toContain("If no\nproject-specific patterns exist, generate 2-3 starter patterns");
    expect(prompt).toContain("Edge targets are relative to the .mex/ scaffold root");
    expect(prompt).toContain("fill only incomplete .mex/context/ slots");
  });

  it("produces a grounded and anchored scaffold from real setup graph facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-setup-grounding-"));
    roots.push(root);
    const sourceDir = join(root, "src");
    const patternDir = join(root, ".mex", "patterns");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(patternDir, { recursive: true });
    writeFileSync(join(sourceDir, "checkout.ts"), `
export function calculateCheckoutTotal(items: number[], member: boolean): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const volumeDiscount = items.length >= 5 ? subtotal * 0.10 : 0;
  const memberDiscount = member ? subtotal * 0.05 : 0;
  const shipping = subtotal >= 100 ? 0 : 12;
  const taxable = subtotal - volumeDiscount - memberDiscount;
  const tax = taxable * 0.18;
  return taxable + tax + shipping;
}
`);

    // Real setup ordering: build the graph first, then the population agent consumes CLI facts.
    const builder = createGraphEngine({ rootDir: root });
    await builder.build();
    builder.close();

    const jsonl: string[] = [];
    runGraphScope("calculateCheckoutTotal", root, { write: (line) => jsonl.push(line) }, { fingerprint: true });
    const fact = jsonl.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.type === "fact" && row.name === "calculateCheckoutTotal");
    expect(fact).toBeDefined();
    expect(deserializeFingerprint(String(fact!.fingerprint))).not.toBeNull();

    // Deterministic agent harness: make one behavioral assertion from the real hydrated fact.
    const pattern = join(patternDir, "calculate-checkout.md");
    const skeleton = `---\nname: calculate-checkout\ndescription: Calculate checkout totals\ngrounds_to: []\n---\n\n# Calculate Checkout\n`;
    const grounded = writeGroundings(skeleton, [{
      node: String(fact!.id),
      fingerprint: String(fact!.fingerprint),
    }]);
    writeFileSync(pattern, grounded + `\n[\`calculateCheckoutTotal()\`](mex://${String(fact!.id)}) applies discounts, tax, and shipping.\n`);

    const generated = readFileSync(pattern, "utf-8");
    const groundings = extractGroundings(generated);
    const anchors = findMexAnchors(generated);
    expect(groundings).toHaveLength(1);
    expect(anchors).toHaveLength(1);
    const verifier = createGraphEngine({ rootDir: root });
    expect(verifier.getNode(groundings[0].node)).not.toBeNull();
    expect(verifier.getNode(anchors[0].nodeId)).not.toBeNull();
    verifier.close();
    expect(checkBrokenLinks([pattern], root, join(root, ".mex"))).toEqual([]);

    const navigation = join(patternDir, "navigation.md");
    writeFileSync(navigation, `# Navigation\n\n[\`calculateCheckoutTotal()\`](mex://${groundings[0].node})\n`);

    const config = { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] };
    const captured = await captureGroundingBaselines(config);
    expect(captured).toEqual({ captured: 2, skipped: 0 });
    const runtime = await loadGroundingRuntime(config);
    expect(runtime!.fingerprints.getGroundedSource(".mex/patterns/calculate-checkout.md", groundings[0].node))
      .not.toBeNull();
    expect(runtime!.fingerprints.getGroundedSource(".mex/patterns/navigation.md", groundings[0].node))
      .not.toBeNull();
    runtime!.close();

    // Setup then migrates the legacy frontmatter and builds the Wiki index.
    const finalized = await finalizeSetupWiki({ projectRoot: root, scaffoldRoot: join(root, ".mex") });
    expect(finalized.ready).toBe(true);
    expect(existsSync(join(root, ".mex", "wiki.db"))).toBe(true);
    expect(extractGroundings(readFileSync(pattern, "utf-8"))[0]?.bodyHash).toMatch(/^[0-9a-f]{64}$/u);

    writeFileSync(join(sourceDir, "checkout.ts"), readFileSync(join(sourceDir, "checkout.ts"), "utf-8")
      .replace("subtotal >= 100 ? 0 : 12", "subtotal >= 125 ? 0 : 15"));
    const warnings: string[] = [];
    let drift = await runDriftCheckWithGraphStatus(config, { graphWarning: (message) => warnings.push(message) });
    expect(drift.graphStatus?.status).toBe("stale");
    // Source-only staleness no longer hides the edit (#228). checkout.ts is
    // compiler-extracted, so without a refresh its groundings are unverified:
    // never clean, and never a definite verdict guessed from a stale snapshot.
    const staleGrounding = drift.issues.filter((issue) => issue.code.startsWith("GROUNDING_"));
    expect(staleGrounding.length).toBeGreaterThan(0);
    expect(staleGrounding.every((issue) => issue.code === "GROUNDING_UNVERIFIED")).toBe(true);
    expect(staleGrounding).toContainEqual(expect.objectContaining({
      code: "GROUNDING_UNVERIFIED",
      file: ".mex/patterns/calculate-checkout.md",
    }));
    expect(warnings).toContainEqual(expect.stringContaining("Run `mex graph refresh`"));

    const refreshRuntime = await loadGroundingRuntime(config);
    refreshRuntime!.close();
    drift = await runDriftCheckWithGraphStatus(config, { graphWarning: (message) => warnings.push(message) });
    expect(drift.graphStatus?.status).toBe("fresh");
    expect(drift.issues).toContainEqual(expect.objectContaining({
      code: "GROUNDING_DRIFT",
      file: ".mex/patterns/calculate-checkout.md",
    }));

    // Review this behavioral claim explicitly. Its navigation-only sibling is
    // not a behavioral assertion and keeps its historical cache unchanged.
    const reviewRuntime = await loadGroundingRuntime(config);
    const acceptance = previewGroundingBaseline(config, ".mex/patterns/calculate-checkout.md", groundings[0].node, reviewRuntime!)!.acceptance;
    reviewRuntime!.close();
    expect(await captureGroundingBaselines(config, { acceptedGroundings: [acceptance] }))
      .toEqual({ captured: 1, skipped: 0 });
    const clean = await runDriftCheckWithGraphStatus(config, { graphWarning: (message) => warnings.push(message) });
    expect(clean.graphStatus?.status).toBe("fresh");
    expect(clean.issues.filter((issue) => issue.code.startsWith("GROUNDING_"))).toEqual([]);
  }, 30_000);

  it("skips and warns when authored grounding no longer resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-setup-grounding-miss-"));
    roots.push(root);
    const scaffoldRoot = join(root, ".mex");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(scaffoldRoot, "patterns"), { recursive: true });
    writeFileSync(join(root, "src", "service.ts"), "export function liveService(): number { return 1; }\n");
    writeFileSync(join(scaffoldRoot, "patterns", "missing.md"),
      "# Missing\n\n[`removedService()`](mex://function:missing)\n");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const warnings: string[] = [];
    const result = await captureGroundingBaselines(
      { projectRoot: root, scaffoldRoot, aiTools: [] },
      { warn: (message) => warnings.push(message) },
    );
    expect(result).toEqual({ captured: 0, skipped: 1 });
    expect(warnings).toContainEqual(expect.stringContaining("function:missing"));
  }, 30_000);
});
