import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphEngine } from "../../graph/engine.js";
import type { Reconciler } from "../../graph/reconcile.js";
import { serializeFingerprint } from "../../graph/fingerprint.js";
import { makeGroundingChecker } from "../checkers/grounding.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("unverified committed grounding", () => {
  it("reports an undecodable missing reference even when it carries a body baseline", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-unverified-grounding-"));
    roots.push(root);
    const file = join(root, "claim.md");
    const text = "---\ngrounds_to:\n  - node: function:missing\n    fingerprint: malformed\n    bodyHash: historical-body\n---\n\n# Claim\n";
    writeFileSync(file, text);
    const graph = { getNode: () => null } as unknown as GraphEngine;
    const reconciler: Reconciler = { reconcile: () => { throw new Error("undecodable fingerprint must not reconcile"); } };
    const check = makeGroundingChecker(graph, reconciler);
    expect(check(null, file, "claim.md", root, root)).toMatchObject([{
      code: "GROUNDING_UNVERIFIED", severity: "warning", verdict: "unverified",
    }]);
  });
  it("reports a missing baseline instead of inferring unchanged literals from identity", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-legacy-grounding-"));
    roots.push(root);
    const file = join(root, "claim.md");
    const fingerprint = { minhash: Array.from({ length: 64 }, (_, index) => index), neighbors: [], tokenCount: 40 };
    const text = `---\ngrounds_to:\n  - node: function:legacy\n    fingerprint: ${serializeFingerprint(fingerprint)}\n---\n\n# Claim\n`;
    writeFileSync(file, text);
    const graph = { getNode: () => ({ id: "function:legacy", filePath: "src/a.ts", startLine: 1, endLine: 2, bodyHash: "current-body" }) } as unknown as GraphEngine;
    const reconciler = { getFingerprint: () => fingerprint, reconcile: () => ({ kind: "GONE" as const }) };
    const check = makeGroundingChecker(graph, reconciler);
    expect(check(null, file, "claim.md", root, root)).toMatchObject([{
      code: "GROUNDING_NO_BASELINE", severity: "warning", verdict: "unverified",
    }]);
  });
});
