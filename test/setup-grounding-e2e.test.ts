import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExistingNoBriefPrompt, buildExistingWithBriefPrompt } from "../src/setup/prompts.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { runGraphScope } from "../src/graph/cli-agent.js";
import { deserializeFingerprint } from "../src/graph/fingerprint.js";
import { extractGroundings, findMexAnchors, writeGroundings } from "../src/markdown.js";
import { checkBrokenLinks } from "../src/drift/checkers/broken-link.js";

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
      expect(prompt).not.toContain("Read 2-3 representative files");
    }
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
    runGraphScope("calculateCheckoutTotal", root, { write: (line) => jsonl.push(line) });
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
  });
});
