import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MexConfig } from "../src/types.js";
import { buildGroundMigrationPrompt, runGraphGround } from "../src/graph/cli-ground.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { runGraphScope } from "../src/graph/cli-agent.js";
import { extractGroundings, findMexAnchors, writeGroundings } from "../src/markdown.js";
import { runDriftCheck } from "../src/drift/index.js";

const roots: string[] = [];

function fixture(): { root: string; scaffold: string; config: MexConfig } {
  const root = mkdtempSync(join(tmpdir(), "mex-ground-migration-"));
  roots.push(root);
  const scaffoldRoot = join(root, ".mex");
  const scaffold = join(scaffoldRoot, "patterns", "checkout.md");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(scaffoldRoot, "patterns"), { recursive: true });
  writeFileSync(join(scaffoldRoot, "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "src", "checkout.ts"), `
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
  writeFileSync(scaffold, `---
name: checkout
description: Checkout calculation workflow
last_updated: 2026-07-01
---

# Checkout

Run \`calculateCheckoutTotal()\` to apply discounts, tax, and shipping.
Keep the existing order of operations because tax applies after discounts.
`);
  return { root, scaffold, config: { projectRoot: root, scaffoldRoot, aiTools: [] } };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pre-0.7 graph grounding migration", () => {
  it("makes preservation, fingerprint asymmetry, and idempotency explicit", () => {
    const prompt = buildGroundMigrationPrompt();
    expect(prompt).toContain("pointer migration, not a scaffold rewrite");
    expect(prompt).toContain("READ BROAD, GROUND TIGHT");
    expect(prompt).toContain("fingerprints belong ONLY in grounds_to frontmatter");
    expect(prompt).toContain("A second\nrun must leave the file byte-identical");
    expect(prompt).toContain("Do not create or delete scaffold files");
  });

  it("grounds existing prose with real graph facts and is byte-idempotent", async () => {
    const { root, scaffold, config } = fixture();
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const original = readFileSync(scaffold, "utf-8");
    const originalProse = original.slice(original.indexOf("# Checkout"));

    const deterministicAgent = (_prompt: string, cwd: string): boolean => {
      const rows: string[] = [];
      runGraphScope("calculateCheckoutTotal", cwd, { write: (line) => rows.push(line) });
      const fact = rows.map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.name === "calculateCheckoutTotal")!;
      let content = readFileSync(scaffold, "utf-8");
      const existing = extractGroundings(content);
      if (!existing.some((entry) => entry.node === fact.id)) {
        content = writeGroundings(content, [...existing, {
          node: String(fact.id), fingerprint: String(fact.fingerprint),
        }]);
      }
      if (findMexAnchors(content).every((anchor) => anchor.nodeId !== fact.id)) {
        content = content.replace(
          "`calculateCheckoutTotal()`",
          "[`calculateCheckoutTotal()`](mex://" + String(fact.id) + ")",
        );
      }
      writeFileSync(scaffold, content);
      return true;
    };

    expect(runGraphGround(config, {}, { runAgent: deterministicAgent })).toBe("ran");
    const migrated = readFileSync(scaffold, "utf-8");
    const groundings = extractGroundings(migrated);
    const anchors = findMexAnchors(migrated);
    expect(groundings).toHaveLength(1);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].nodeId).toBe(groundings[0].node);
    expect(anchors[0].nodeId).not.toContain("mh:64:");
    const verifier = createGraphEngine({ rootDir: root });
    expect(verifier.getNode(groundings[0].node)).not.toBeNull();
    expect(verifier.getNode(anchors[0].nodeId)).not.toBeNull();
    verifier.close();
    const visibleMigrated = migrated.slice(migrated.indexOf("# Checkout"))
      .replace(/\[(`[^`]+`)\]\(mex:\/\/[^)]+\)/g, "$1");
    expect(visibleMigrated).toBe(originalProse);

    expect(runGraphGround(config, {}, { runAgent: deterministicAgent })).toBe("ran");
    expect(readFileSync(scaffold, "utf-8")).toBe(migrated);
  });

  it("requires a built graph", () => {
    const { config } = fixture();
    expect(() => runGraphGround(config, { dryRun: true })).toThrow(
      "Run `mex graph` before `mex graph ground`",
    );
  });

  it("nudges populated ungrounded scaffolds through graph build then migration", async () => {
    const { root, config } = fixture();
    const warning = vi.fn();
    await runDriftCheck(config, { groundingRuntimeLoader: async () => null, graphWarning: warning });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("mex graph`, then `mex graph ground"));

    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const runtime = await import("../src/graph/runtime.js").then(({ loadGroundingRuntime }) => loadGroundingRuntime(config));
    await runDriftCheck(config, { groundingRuntimeLoader: async () => runtime, graphWarning: warning });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Run `mex graph ground` to connect it"));
  });
});
