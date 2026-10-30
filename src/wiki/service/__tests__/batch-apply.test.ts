/**
 * `wiki apply` with an array: validated whole, planned whole, written whole.
 *
 * Every problem in a batch is reported at once under its index and nothing is
 * written; a clean batch writes every operation in order, with one audit
 * intent/complete pair per operation; and replay stays per operation, so a
 * batch that is re-run, grown or interrupted continues rather than starting
 * over or duplicating knowledge.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOperation } from "../../operations/apply.js";
import type { GroundingGraph } from "../../grounding/adapter.js";
import { parseWikiMarkdown } from "../../markdown/codec.js";
import { WIKI_APPLY_BATCH_MAX, wikiApplyOperationBatch } from "../write.js";
import { ACTOR, GATEWAY, makeScaffold, type Scaffold } from "../../operations/__tests__/helpers.js";

const NODE = "function:00000000000000000000000000000005";
const graph: GroundingGraph = {
  getNode: (id) => (id === NODE ? { id: NODE, bodyHash: "5".repeat(64), filePath: "src/router.ts", startLine: 10, endLine: 15 } : null),
  getFingerprint: (id) => (id === NODE ? "mh:64:00000005" : null),
  reconcile: () => null,
  getBaselineSource: () => null,
  declarationsInFile: (path) => path === "src/router.ts"
    ? [{ id: NODE, kind: "function", name: "parseBody", qualifiedName: "parseBody", startLine: 10, endLine: 15, hasBody: true }]
    : null,
};

const scaffolds: Scaffold[] = [];
function scaffold(): Scaffold {
  const made = makeScaffold();
  scaffolds.push(made);
  return made;
}
afterEach(() => {
  while (scaffolds.length > 0) scaffolds.pop()!.dispose();
});

function fact(opId: string, file: string, title: string, groundsTo?: unknown[]): Record<string, unknown> {
  return {
    opId,
    type: "create-entry",
    actor: ACTOR,
    timestamp: "2026-10-23T10:00:00.000Z",
    reason: "batch test",
    payload: {
      file,
      insertAt: { at: "end-of-file" },
      type: "fact",
      title,
      body: `${title}, as the code says.`,
      headingDepth: 2,
      status: "promoted",
      ...(groundsTo === undefined ? {} : { groundsTo }),
    },
  };
}

const auditLines = (target: Scaffold): Array<{ opId: string; phase: string }> => {
  const path = join(target.root, "events", "operations.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { opId: string; phase: string })
    : [];
};

const apply = (target: Scaffold, envelopes: unknown, write = true) =>
  wikiApplyOperationBatch(envelopes, { scaffoldRoot: target.root, graph, ...(write ? { apply: true } : {}) });

describe("a batch with problems", () => {
  it("writes nothing and reports every problem under its index", () => {
    const target = scaffold();
    const before = target.files();
    const batch = [
      fact("b-0", "context/architecture.md", "Bodies are parsed once", [{ file: "src/router.ts", symbol: "parseBody" }]),
      fact("b-1", "context/architecture.md", "Unknown code", [{ file: "src/router.ts", symbol: "nothingHere" }]),
      { ...fact("b-2", "context/routing.md", "No opId"), opId: undefined },
      fact("b-3", "context/routing.md", "Bad file", [{ file: "../outside.ts", symbol: "x" }]),
    ];
    const result = apply(target, batch);

    expect(result.data.applied).toBe(false);
    expect(target.files()).toEqual(before);
    expect(existsSync(join(target.root, "context/routing.md"))).toBe(false);
    expect(auditLines(target)).toEqual([]);
    const errors = result.diagnostics.filter((entry) => entry.severity === "error");
    expect(errors.map((entry) => entry.path?.match(/^\[(\d+)\]/)?.[1]).sort()).toEqual(["1", "2", "3"]);
    expect(errors.find((entry) => entry.path?.startsWith("[1]"))?.code).toBe("GROUNDING_NOT_FOUND");
    expect(errors.find((entry) => entry.path?.startsWith("[1]"))?.message).toMatch(/^Operation 1 \(b-1\): /);
    expect(errors.find((entry) => entry.path?.startsWith("[2]"))?.message).toMatch(/^Operation 2: /);
    expect(result.data.operations.map((operation) => operation.status)).toEqual(["blocked", "refused", "refused", "refused"]);
  });

  it("reports a plan-time conflict in a later operation and writes nothing", () => {
    const target = scaffold();
    const before = target.files();
    const stale = {
      opId: "b-stale", type: "update-entry", actor: ACTOR, timestamp: "2026-10-23T10:00:00.000Z",
      entityId: GATEWAY, baseRevision: 1, baseContentHash: "0".repeat(64),
      payload: { body: "Changed." },
    };
    const result = apply(target, [fact("b-ok", "context/architecture.md", "Fine on its own"), stale]);
    expect(result.data.applied).toBe(false);
    expect(target.files()).toEqual(before);
    expect(auditLines(target)).toEqual([]);
    expect(result.diagnostics.some((entry) => entry.severity === "error" && entry.path?.startsWith("[1]"))).toBe(true);
  });

  it("refuses duplicate opIds, an empty batch and an oversized one", () => {
    const target = scaffold();
    const duplicate = apply(target, [fact("same", "context/architecture.md", "One"), fact("same", "context/architecture.md", "Two")]);
    expect(duplicate.diagnostics.some((entry) => entry.path === "[1]" && entry.message.includes("already used by operation 0"))).toBe(true);
    expect(apply(target, []).diagnostics[0]?.code).toBe("INVALID_OPERATION_ENVELOPE");
    const tooMany = Array.from({ length: WIKI_APPLY_BATCH_MAX + 1 }, (_, index) => fact(`m-${index}`, "context/architecture.md", `Fact ${index}`));
    const oversized = apply(target, tooMany);
    expect(oversized.diagnostics[0]?.message).toContain(`at most ${WIKI_APPLY_BATCH_MAX}`);
    expect(auditLines(target)).toEqual([]);
  });
});

describe("a clean batch", () => {
  it("previews without writing, then writes every operation in order", () => {
    const target = scaffold();
    const before = target.files();
    const batch = [
      fact("c-0", "context/architecture.md", "Bodies are parsed once", [{ file: "./src/router.ts", symbol: "parseBody" }]),
      fact("c-1", "context/routing.md", "Routes live in a trie"),
      fact("c-2", "context/routing.md", "Routes match by prefix", [{ file: "src/router.ts", line: 12 }]),
    ];
    const preview = apply(target, batch, false);
    expect(preview.data.planned).toBe(true);
    expect(preview.data.applied).toBe(false);
    expect(preview.data.diff).toContain("Routes live in a trie");
    expect(target.files()).toEqual(before);
    expect(auditLines(target)).toEqual([]);

    const result = apply(target, batch);
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(result.data.applied).toBe(true);
    expect(result.data.operations.map((operation) => operation.status)).toEqual(["applied", "applied", "applied"]);
    expect(result.data.changedFiles).toEqual(["context/architecture.md", "context/routing.md"]);
    expect(auditLines(target).map((line) => `${line.opId}:${line.phase}`)).toEqual([
      "c-0:intent", "c-0:complete", "c-1:intent", "c-1:complete", "c-2:intent", "c-2:complete",
    ]);
    const routing = parseWikiMarkdown({ path: "context/routing.md", text: target.read("context/routing.md") }).entities;
    const parent = routing.find((entry) => entry.metadataKind === "frontmatter")!.entity.id;
    // Stamped once by the first operation into the new file; both facts refine it.
    expect(routing.filter((entry) => entry.entity.type === "fact").map((entry) => entry.entity.relations[0]?.target)).toEqual([parent, parent]);
    expect(result.data.operations[1]!.createdIds).toHaveLength(2);
    expect(result.data.operations[2]!.createdIds).toHaveLength(1);
    expect(routing.find((entry) => entry.entity.title === "Routes match by prefix")?.entity.groundsTo[0]?.node).toBe(NODE);
  });

  it("replays per operation: re-running does nothing, growing it writes only what is new", () => {
    const target = scaffold();
    const batch = [fact("r-0", "context/architecture.md", "First"), fact("r-1", "context/architecture.md", "Second")];
    const first = apply(target, batch);
    expect(first.data.applied).toBe(true);
    const written = target.files();

    const again = apply(target, batch);
    expect(again.data.replayed).toBe(true);
    expect(again.data.applied).toBe(false);
    expect(again.data.createdIds).toEqual(first.data.createdIds);
    expect(target.files()).toEqual(written);

    const grown = apply(target, [...batch, fact("r-2", "context/architecture.md", "Third")]);
    expect(grown.data.operations.map((operation) => operation.status)).toEqual(["replayed", "replayed", "applied"]);
    expect(auditLines(target)).toHaveLength(6);
  });

  it("refuses an opId reused for a different change", () => {
    const target = scaffold();
    apply(target, [fact("x-0", "context/architecture.md", "Original")]);
    const written = target.files();
    const changed = apply(target, [fact("x-0", "context/architecture.md", "Rewritten")]);
    expect(changed.data.operations[0]!.status).toBe("refused");
    expect(changed.diagnostics[0]?.message).toContain("already recorded for a different change");
    expect(target.files()).toEqual(written);
  });

  it("finishes an interrupted operation with its recorded ids before the rest", () => {
    const target = scaffold();
    const batch = [fact("i-0", "context/architecture.md", "Interrupted"), fact("i-1", "context/architecture.md", "After")];
    // A process killed after the file landed but before its completion line.
    expect(() => applyOperation(batch[0], {
      scaffoldRoot: target.root,
      deriveStructure: true,
      onFileWritten: () => { throw new Error("killed"); },
    })).toThrow();
    const landed = parseWikiMarkdown({ path: "context/architecture.md", text: target.read("context/architecture.md") })
      .entities.filter((entry) => entry.entity.title === "Interrupted");
    expect(landed).toHaveLength(1);

    const result = apply(target, batch);
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(result.data.operations.map((operation) => operation.status)).toEqual(["resumed", "applied"]);
    const after = parseWikiMarkdown({ path: "context/architecture.md", text: target.read("context/architecture.md") }).entities;
    expect(after.filter((entry) => entry.entity.title === "Interrupted").map((entry) => entry.entity.id)).toEqual([landed[0]!.entity.id]);
    expect(after.filter((entry) => entry.entity.title === "After")).toHaveLength(1);
    expect(auditLines(target).map((line) => `${line.opId}:${line.phase}`)).toEqual([
      "i-0:intent", "i-0:complete", "i-1:intent", "i-1:complete",
    ]);
  });
});
