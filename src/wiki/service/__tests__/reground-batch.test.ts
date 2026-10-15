import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GroundingGraph } from "../../grounding/adapter.js";
import { wikiRegroundEntities, wikiRegroundEntity } from "../reground.js";

const A = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const B = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const C = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAC";
const NODE_A = "function:1a2b3c4d5e6f7a8b";
const NODE_B = "function:2b3c4d5e6f7a8b9c";
const NODE_C = "function:3c4d5e6f7a8b9c0d";
const FINGERPRINT = "mh:64:0a0b0c0d";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function entityText(id: string, node: string, title: string): string {
  return `---\nmex:\n  id: ${id}\n  type: pattern\n  status: promoted\n  revision: 1\n  title: ${title}\n  grounds_to:\n    - node: ${node}\n      fingerprint: ${FINGERPRINT}\n---\n\n# ${title}\n\nThe behavior was reviewed.\n`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-reground-batch-"));
  roots.push(root);
  mkdirSync(join(root, "context"));
  const files: Record<string, string> = {};
  for (const [id, node, name] of [[A, NODE_A, "a"], [B, NODE_B, "b"], [C, NODE_C, "c"]] as const) {
    files[id] = join(root, "context", `${name}.md`);
    writeFileSync(files[id]!, entityText(id, node, `Claim ${name}`));
  }
  return { root, files };
}

/** A graph where NODE_C has no body hash (the batch must refuse C and still handle A and B). */
function graph(): GroundingGraph {
  const bodies: Record<string, string | null> = { [NODE_A]: "body-a", [NODE_B]: "body-b", [NODE_C]: null };
  return {
    getNode: (id) => id in bodies ? { id, bodyHash: bodies[id] ?? null, filePath: "src/x.ts", startLine: 1, endLine: 2 } : null,
    getFingerprint: () => FINGERPRINT,
    reconcile: () => ({ kind: "GONE" }),
    getBaselineSource: () => { throw new Error("no baseline"); },
    rememberBody: () => undefined,
  };
}

describe("batch reground", () => {
  it("re-records every id in one call with a result each", () => {
    const fx = fixture();
    const result = wikiRegroundEntities([A, B], { scaffoldRoot: fx.root, graph: graph(), apply: true, reason: "reviewed" });
    expect(result.data.entities.map((e) => [e.entityId, e.ok])).toEqual([[A, true], [B, true]]);
    expect(result.data).toMatchObject({ applied: 2, planned: 0, failed: 0 });
    expect(readFileSync(fx.files[A]!, "utf8")).toContain("bodyHash: body-a");
    expect(readFileSync(fx.files[B]!, "utf8")).toContain("bodyHash: body-b");
  });

  it("reports a partial failure and still writes the others", () => {
    const fx = fixture();
    const before = readFileSync(fx.files[C]!, "utf8");
    const result = wikiRegroundEntities([A, C, "mx_01ARZ3NDEKTSV4RRFFQ69G5ZZZ", B], { scaffoldRoot: fx.root, graph: graph(), apply: true });
    expect(result.data.entities.map((e) => e.ok)).toEqual([true, false, false, true]);
    expect(result.data).toMatchObject({ applied: 2, failed: 2 });
    expect(result.data.entities[1]!.diagnostics[0]!.code).toBe("GROUNDING_UNRESOLVED");
    expect(result.data.entities[2]!.diagnostics[0]!.code).toBe("ENTITY_NOT_FOUND");
    expect(readFileSync(fx.files[C]!, "utf8")).toBe(before);
    expect(readFileSync(fx.files[A]!, "utf8")).toContain("bodyHash: body-a");
  });

  it("plans without writing and drops duplicate ids", () => {
    const fx = fixture();
    const before = readFileSync(fx.files[A]!, "utf8");
    const result = wikiRegroundEntities([A, A, B], { scaffoldRoot: fx.root, graph: graph() });
    expect(result.data.entities).toHaveLength(2);
    expect(result.data).toMatchObject({ applied: 0, planned: 2, failed: 0 });
    expect(readFileSync(fx.files[A]!, "utf8")).toBe(before);
  });

  it("gives each id the same result the single-id call gives", () => {
    const fx = fixture();
    const single = wikiRegroundEntity(A, { scaffoldRoot: fx.root, graph: graph(), now: () => new Date("2026-10-15T00:00:00Z") });
    const batch = wikiRegroundEntities([A], { scaffoldRoot: fx.root, graph: graph(), now: () => new Date("2026-10-15T00:00:00Z") });
    const { ok: _ok, diagnostics: _d, ...entry } = batch.data.entities[0]!;
    expect(entry).toEqual(single.data);
  });

  it("without a graph, every id is refused and nothing is written", () => {
    const fx = fixture();
    const result = wikiRegroundEntities([A, B], { scaffoldRoot: fx.root, apply: true });
    expect(result.data).toMatchObject({ applied: 0, failed: 2 });
    expect(result.diagnostics.every((d) => d.code === "CODE_GRAPH_UNAVAILABLE")).toBe(true);
  });
});
