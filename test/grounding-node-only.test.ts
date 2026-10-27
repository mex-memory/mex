/**
 * An agent writes a grounding as a node id; MEX records the fingerprint.
 *
 * The finalize step (`captureGroundingBaselines`, shared by setup, ground
 * migration and sync) fills a missing fingerprint from the live graph. What it
 * must not do is loosen the rule: a node the graph does not hold, or a supplied
 * fingerprint that is not the graph's, still stops the file from being baselined.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { runGraphScope } from "../src/graph/cli-agent.js";
import { deserializeFingerprint } from "../src/graph/fingerprint.js";
import { captureGroundingBaselines } from "../src/graph/runtime.js";
import { extractGroundings, fillMissingFingerprints } from "../src/markdown.js";
import { assertGroundingCaptureReady } from "../src/setup/index.js";
import {
  buildExistingNoBriefPrompt,
  buildExistingWithBriefPrompt,
} from "../src/setup/prompts.js";
import { buildGroundMigrationPrompt } from "../src/graph/cli-ground.js";
import { buildKnowledgeUpgradeBrief } from "../src/sync/knowledge-upgrade.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FP_A = "mh2:64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("fillMissingFingerprints", () => {
  const lookup = (node: string): string | null => (node === "function:aaaaaaaa" ? FP_A : null);

  it("fills a node-only root entry and leaves every other byte alone", () => {
    const content = `---\nname: demo\n# keep this comment\ngrounds_to:\n  - node: "function:aaaaaaaa"\nlast_updated: 2026-01-01\n---\n\n# Demo\n`;
    const result = fillMissingFingerprints(content, lookup);
    expect(result.filled).toBe(1);
    expect(result.unresolved).toEqual([]);
    expect(result.content).toContain("# keep this comment");
    expect(result.content).toContain("last_updated: 2026-01-01");
    expect(extractGroundings(result.content)).toEqual([{ node: "function:aaaaaaaa", fingerprint: FP_A }]);
  });

  it("fills entries under mex.grounds_to", () => {
    const content = `---\nmex:\n  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n  type: pattern\n  grounds_to:\n    - node: "function:aaaaaaaa"\n---\n# Demo\n`;
    const result = fillMissingFingerprints(content, lookup);
    expect(result.filled).toBe(1);
    expect(extractGroundings(result.content)).toEqual([{ node: "function:aaaaaaaa", fingerprint: FP_A }]);
  });

  it("never replaces a fingerprint that is already there", () => {
    const content = `---\ngrounds_to:\n  - node: "function:aaaaaaaa"\n    fingerprint: "mh2:64:BBBB"\n---\n# Demo\n`;
    const result = fillMissingFingerprints(content, lookup);
    expect(result.filled).toBe(0);
    expect(result.content).toBe(content);
  });

  it("fills only the entries that lack one", () => {
    const content = `---\ngrounds_to:\n  - node: "function:aaaaaaaa"\n    fingerprint: "mh2:64:BBBB"\n    bodyHash: abc\n  - node: "function:aaaaaaaa"\n---\n# Demo\n`;
    const result = fillMissingFingerprints(content, lookup);
    expect(result.filled).toBe(1);
    expect(result.content).toContain("mh2:64:BBBB");
    expect(result.content).toContain("bodyHash: abc");
  });

  it("writes nothing for a file that names a node the lookup cannot answer", () => {
    const content = `---\ngrounds_to:\n  - node: "function:aaaaaaaa"\n  - node: "function:cafebabe"\n---\n# Demo\n`;
    const result = fillMissingFingerprints(content, lookup);
    expect(result.content).toBe(content);
    expect(result.filled).toBe(0);
    expect(result.unresolved).toEqual(["function:cafebabe"]);
  });

  it("leaves a file with no groundings, or a store it cannot read, untouched", () => {
    for (const content of ["# No frontmatter\n", "---\nname: x\n---\n# X\n", "---\ngrounds_to: []\n---\n# X\n", "---\ngrounds_to:\n  - not-an-object\n---\n# X\n"]) {
      expect(fillMissingFingerprints(content, lookup)).toEqual({ content, filled: 0, unresolved: [] });
    }
  });
});

describe("captureGroundingBaselines with a node-only grounding", () => {
  async function project(): Promise<{ root: string; pattern: string; ids: Record<string, string>; fingerprints: Record<string, string> }> {
    const root = mkdtempSync(join(tmpdir(), "mex-node-only-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".mex", "patterns"), { recursive: true });
    writeFileSync(join(root, "src", "checkout.ts"), `
export function calculateCheckoutTotal(items: number[], member: boolean): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const volumeDiscount = items.length >= 5 ? subtotal * 0.10 : 0;
  const memberDiscount = member ? subtotal * 0.05 : 0;
  const shipping = subtotal >= 100 ? 0 : 12;
  const taxable = subtotal - volumeDiscount - memberDiscount;
  return taxable * 1.18 + shipping;
}

export function formatReceiptLine(name: string, cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  const padded = name.padEnd(24, " ");
  return padded + dollars.padStart(10, " ") + "\\n";
}
`);
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const ids: Record<string, string> = {};
    const fingerprints: Record<string, string> = {};
    for (const name of ["calculateCheckoutTotal", "formatReceiptLine"]) {
      const rows: string[] = [];
      runGraphScope(name, root, { write: (line) => rows.push(line) }, { fingerprint: true });
      const fact = rows.map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.type === "fact" && row.name === name)!;
      ids[name] = String(fact.id);
      fingerprints[name] = String(fact.fingerprint);
    }
    return { root, pattern: join(root, ".mex", "patterns", "checkout.md"), ids, fingerprints };
  }

  const config = (root: string) => ({ projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] });

  it("records the graph's own fingerprint and body hash", async () => {
    const { root, pattern, ids, fingerprints } = await project();
    writeFileSync(pattern, `---\nname: checkout\ndescription: Checkout totals\ngrounds_to:\n  - node: "${ids.calculateCheckoutTotal}"\nlast_updated: 2026-01-01\n---\n\n# Checkout\n`);

    const result = await captureGroundingBaselines(config(root));

    expect(result).toEqual({ captured: 1, skipped: 0 });
    const [grounding] = extractGroundings(readFileSync(pattern, "utf-8"));
    expect(grounding!.node).toBe(ids.calculateCheckoutTotal);
    expect(deserializeFingerprint(grounding!.fingerprint)).toEqual(deserializeFingerprint(fingerprints.calculateCheckoutTotal!));
    expect(grounding!.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    // A second pass leaves the file exactly as the first wrote it.
    const written = readFileSync(pattern, "utf-8");
    expect(await captureGroundingBaselines(config(root))).toEqual({ captured: 1, skipped: 0 });
    expect(readFileSync(pattern, "utf-8")).toBe(written);
  }, 30_000);

  it("does not baseline a file that names a node the graph does not hold", async () => {
    const { root, pattern, ids } = await project();
    const content = `---\nname: checkout\ngrounds_to:\n  - node: "${ids.calculateCheckoutTotal}"\n  - node: "function:00000000000000000000000000000000"\n---\n\n# Checkout\n`;
    writeFileSync(pattern, content);
    const warnings: string[] = [];

    const result = await captureGroundingBaselines(config(root), { warn: (message) => warnings.push(message) });

    expect(result.captured).toBe(0);
    expect(result.skipped).toBe(1);
    expect(warnings.join("\n")).toContain("function:00000000000000000000000000000000");
    expect(readFileSync(pattern, "utf-8")).toBe(content);
    expect(() => assertGroundingCaptureReady(result)).toThrow(/could not be verified/);
  }, 30_000);

  it("still refuses a supplied fingerprint that is not the node's", async () => {
    const { root, pattern, ids, fingerprints } = await project();
    const content = `---\nname: checkout\ngrounds_to:\n  - node: "${ids.calculateCheckoutTotal}"\n    fingerprint: "${fingerprints.formatReceiptLine}"\n---\n\n# Checkout\n`;
    writeFileSync(pattern, content);

    const result = await captureGroundingBaselines(config(root));

    expect(result.captured).toBe(0);
    expect(result.skipped).toBe(1);
    expect(readFileSync(pattern, "utf-8")).toBe(content);
  }, 30_000);

  describe("one unresolved reference does not hide the rest of its file", () => {
    const UNKNOWN = "function:00000000000000000000000000000000";

    it("still verifies the other groundings of a new file, reports each once, and writes nothing", async () => {
      const { root, pattern, ids, fingerprints } = await project();
      const content = `---\nname: checkout\ngrounds_to:\n  - node: "${ids.calculateCheckoutTotal}"\n  - node: "${UNKNOWN}"\n  - node: "${ids.formatReceiptLine}"\n    fingerprint: "${fingerprints.calculateCheckoutTotal}"\n---\n\n# Checkout\n`;
      writeFileSync(pattern, content);

      const result = await captureGroundingBaselines(config(root));
      expect(result.captured).toBe(0);
      expect(result.failures!.map((failure) => [failure.node, failure.kind]).sort()).toEqual([
        [ids.formatReceiptLine, "new"], [UNKNOWN, "new"],
      ].sort());
      expect(result.failures!.filter((failure) => failure.node === UNKNOWN)).toHaveLength(1);
      expect(result.failures!.some((failure) => failure.node === ids.calculateCheckoutTotal)).toBe(false);
      expect(readFileSync(pattern, "utf-8")).toBe(content);
    }, 30_000);

    it("still verifies the other groundings of a committed file, so drift is reported", async () => {
      const { root, pattern, ids, fingerprints } = await project();
      const content = `---\nname: checkout\ngrounds_to:\n  - node: "${UNKNOWN}"\n  - node: "${ids.formatReceiptLine}"\n    fingerprint: "${fingerprints.calculateCheckoutTotal}"\n---\n\n# Checkout\n`;
      // HEAD holds both references with fingerprints; the working copy has the agent's node-only rewrite of the first.
      writeFileSync(pattern, content.replace(`"${UNKNOWN}"\n`, `"${UNKNOWN}"\n    fingerprint: "${FP_A}"\n`));
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
      git("init", "-q");
      git("add", ".mex/patterns/checkout.md");
      git("commit", "-q", "-m", "committed grounding");
      writeFileSync(pattern, content);

      const result = await captureGroundingBaselines(config(root));
      expect(result.captured).toBe(0);
      expect(result.driftCount).toBe(2);
      expect(result.failures!.map((failure) => [failure.node, failure.kind]).sort()).toEqual([
        [ids.formatReceiptLine, "drift"], [UNKNOWN, "drift"],
      ].sort());
      expect(readFileSync(pattern, "utf-8")).toBe(content);
    }, 30_000);

    it("captures the whole file once the unresolved reference is gone", async () => {
      const { root, pattern, ids } = await project();
      writeFileSync(pattern, `---\nname: checkout\ngrounds_to:\n  - node: "${ids.calculateCheckoutTotal}"\n  - node: "${ids.formatReceiptLine}"\n---\n\n# Checkout\n`);
      expect(await captureGroundingBaselines(config(root))).toEqual({ captured: 2, skipped: 0 });
    }, 30_000);
  });
});

describe("authoring prompts", () => {
  const prompts: Array<[string, string]> = [
    ["setup with brief", buildExistingWithBriefPrompt("{}")],
    ["setup without brief", buildExistingNoBriefPrompt()],
    ["ground migration", buildGroundMigrationPrompt()],
    ["knowledge upgrade", buildKnowledgeUpgradeBrief({ candidates: [{ id: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD", title: "t", file: "context/a.md" }], truncated: false })],
  ];

  it.each(prompts)("%s does not tell the agent to copy a fingerprint", (_name, prompt) => {
    expect(prompt).not.toContain("--fingerprint");
    expect(prompt).not.toMatch(/must copy/i);
    expect(prompt).not.toContain('fingerprint: "<exact fingerprint');
    expect(prompt).not.toContain('"fingerprint": "<exact fingerprint');
  });

  it.each(prompts.slice(0, 2))("%s says MEX records the fingerprint", (_name, prompt) => {
    expect(prompt).toContain("MEX finds it and records the fingerprints");
    expect(prompt).toContain('"groundsTo": [{"file": "src/x.ts", "symbol": "parseBody"}]');
  });
});
