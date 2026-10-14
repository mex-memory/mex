import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GroundingGraph } from "../../grounding/adapter.js";
import { wikiRegroundEntity } from "../reground.js";

const ENTITY = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const NODE = "function:1a2b3c4d5e6f7a8b";
const FINGERPRINT = "mh:64:0a0b0c0d";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(bodyHash?: string) {
  const root = mkdtempSync(join(tmpdir(), "mex-reground-safety-"));
  roots.push(root);
  mkdirSync(join(root, "context"));
  const file = join(root, "context", "claim.md");
  const text = `---\nmex:\n  id: ${ENTITY}\n  type: pattern\n  status: promoted\n  revision: 1\n  title: Claim\n  grounds_to:\n    - node: ${NODE}\n      fingerprint: ${FINGERPRINT}\n${bodyHash === undefined ? "" : `      bodyHash: ${bodyHash}\n`}---\n\n# Claim\n\nThe behavior was reviewed.\n`;
  writeFileSync(file, text);
  return { root, file, text };
}

function graph(current: string | null): GroundingGraph & { remembered: string[] } {
  const remembered: string[] = [];
  return {
    remembered,
    getNode: (id) => id === NODE ? { id: NODE, bodyHash: current, filePath: "src/a.ts", startLine: 1, endLine: 2 } : null,
    getFingerprint: () => FINGERPRINT,
    reconcile: () => ({ kind: "GONE" }),
    getBaselineSource: () => { throw new Error("cached baseline cannot authorize review"); },
    rememberBody: (id, hash) => { remembered.push(`${id}:${hash}`); },
  };
}

describe("explicit baseline review", () => {
  it("plans a missing legacy baseline read-only and caches only after accepted apply", () => {
    const fx = fixture();
    const current = graph("current-body");
    const options = { scaffoldRoot: fx.root, graph: current, now: () => new Date("2026-10-12T00:00:00Z") };
    const planned = wikiRegroundEntity(ENTITY, options);
    expect(planned.data.links).toMatchObject([{ verdict: "unverified", recordedNode: NODE }]);
    expect(planned.data.apply?.applied).toBe(false);
    expect(readFileSync(fx.file, "utf8")).toBe(fx.text);
    expect(current.remembered).toEqual([]);

    const applied = wikiRegroundEntity(ENTITY, { ...options, apply: true, reason: "Compared the claim with the current implementation." });
    expect(applied.diagnostics).toEqual([]);
    expect(applied.data.apply?.applied).toBe(true);
    expect(readFileSync(fx.file, "utf8")).toContain("bodyHash: current-body");
    expect(current.remembered).toEqual([`${NODE}:current-body`]);
  });

  it("refuses to replace a committed baseline when current body evidence is absent", () => {
    const fx = fixture("accepted-body");
    const current = graph(null);
    const refused = wikiRegroundEntity(ENTITY, { scaffoldRoot: fx.root, graph: current, apply: true });
    expect(refused.data.apply).toBeNull();
    expect(refused.diagnostics).toMatchObject([{ code: "GROUNDING_UNRESOLVED" }]);
    expect(readFileSync(fx.file, "utf8")).toBe(fx.text);
    expect(current.remembered).toEqual([]);
  });

  it("keeps a canonical successful apply when its optional source cache fails", () => {
    const fx = fixture();
    const current = graph("current-body");
    current.rememberBody = () => { throw new Error("optional cache unavailable"); };
    const applied = wikiRegroundEntity(ENTITY, { scaffoldRoot: fx.root, graph: current, apply: true,
      reason: "Reviewed the implementation." });
    expect(applied.diagnostics).toEqual([]);
    expect(applied.data.apply?.applied).toBe(true);
    expect(readFileSync(fx.file, "utf8")).toContain("bodyHash: current-body");
  });

});
