/**
 * Authoring through `wiki apply`: an agent names a node, MEX records the
 * fingerprint, and the agent adds a few search phrases (`aliases`) to a fact.
 *
 * The §12.4 rule is unchanged and tested here from both sides: a node-only
 * grounding is accepted only for a node the graph holds, and a fingerprint
 * that is supplied still has to be the graph's own.
 */

import { afterEach, describe, expect, it } from "vitest";
import { applyOperation } from "../apply.js";
import { planOperation } from "../plan.js";
import type { GroundingGraph } from "../../grounding/adapter.js";
import { ARCH, GATEWAY, codesOf, envelope, makeScaffold, type Scaffold } from "./helpers.js";

const NODE = "function:a3f8c21d9e4b7f60a1c2d3e4f5061728";
const FINGERPRINT = "mh:64:9f2a4c6e";
const BODY_HASH = "b".repeat(64);

const graph: GroundingGraph = {
  getNode: (id) => (id === NODE ? { id: NODE, bodyHash: BODY_HASH, filePath: "src/token.ts", startLine: 1, endLine: 9 } : null),
  getFingerprint: (id) => (id === NODE ? FINGERPRINT : null),
  reconcile: () => null,
  getBaselineSource: () => {
    throw new Error("a write must not read the cached baseline");
  },
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

function newFact(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    file: "context/architecture.md",
    insertAt: { at: "end-of-file" },
    type: "fact",
    title: "Tokens expire after an hour",
    body: "A token stops working one hour after it is minted.",
    headingDepth: 2,
    ...extra,
  };
}

describe("a grounding written as a node id alone", () => {
  it("create-entry takes the fingerprint and body hash from the graph", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", newFact({ groundsTo: [{ node: NODE }] })), {
      scaffoldRoot: target.root,
      graph,
    });
    expect(applied.ok).toBe(true);
    expect(target.entity(applied.createdIds[0]!).groundsTo).toEqual([
      { node: NODE, fingerprint: FINGERPRINT, bodyHash: BODY_HASH, file: "src/token.ts" },
    ]);
  });

  it("create-entry refuses a node the graph does not hold, with the existing diagnostic", () => {
    const target = scaffold();
    const before = target.read("context/architecture.md");
    const refused = applyOperation(
      envelope(target, "create-entry", newFact({ groundsTo: [{ node: "function:0000000000000000000000000000000f" }] })),
      { scaffoldRoot: target.root, graph },
    );
    expect(refused.ok).toBe(false);
    expect(codesOf(refused.diagnostics)).toContain("GROUNDING_UNVERIFIED");
    expect(target.read("context/architecture.md")).toBe(before);
  });

  it("create-entry still refuses a supplied fingerprint the graph did not produce", () => {
    const target = scaffold();
    const refused = applyOperation(
      envelope(target, "create-entry", newFact({ groundsTo: [{ node: NODE, fingerprint: "mh:64:deadbeef" }] })),
      { scaffoldRoot: target.root, graph },
    );
    expect(refused.ok).toBe(false);
    expect(codesOf(refused.diagnostics)).toContain("GROUNDING_UNVERIFIED");
  });

  it("create-entry with no graph still refuses a node-only grounding", () => {
    const target = scaffold();
    const refused = applyOperation(envelope(target, "create-entry", newFact({ groundsTo: [{ node: NODE }] })), {
      scaffoldRoot: target.root,
    });
    expect(refused.ok).toBe(false);
    expect(codesOf(refused.diagnostics)).toContain("GROUNDING_UNVERIFIED");
  });

  it("set-grounding takes a node id alone", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "set-grounding", { groundsTo: [{ node: NODE }] }, { entityId: GATEWAY }), {
      scaffoldRoot: target.root,
      graph,
    });
    expect(applied.ok).toBe(true);
    expect(target.entity(GATEWAY).groundsTo).toEqual([
      { node: NODE, fingerprint: FINGERPRINT, bodyHash: BODY_HASH, file: "src/token.ts" },
    ]);
  });

  it("adopt does not derive a missing fingerprint", () => {
    const target = scaffold();
    const planned = planOperation(
      envelope(target, "create-entry", {
        file: "context/architecture.md",
        adopt: { at: "file" },
        type: "fact",
        title: "Adopted",
        groundsTo: [{ node: NODE }],
      }),
      { scaffoldRoot: target.root, graph },
    );
    expect(planned.ok).toBe(false);
    expect(codesOf(planned.diagnostics)).toContain("INVALID_OPERATION_PAYLOAD");
  });

  it("rejects a node field that is not a node id before any graph is consulted", () => {
    const target = scaffold();
    const planned = planOperation(envelope(target, "create-entry", newFact({ groundsTo: [{ node: "tokenService" }] })), {
      scaffoldRoot: target.root,
      graph,
    });
    expect(planned.ok).toBe(false);
    expect(codesOf(planned.diagnostics)).toContain("MALFORMED_GROUNDING");
  });
});

describe("aliases", () => {
  function aliasesOf(target: Scaffold, id: string): unknown {
    return target.entity(id).metadata?.["aliases"];
  }

  it("create-entry stores them under metadata.aliases, trimmed and de-duplicated", () => {
    const target = scaffold();
    const applied = applyOperation(
      envelope(target, "create-entry", newFact({ aliases: ["  token stops working  ", "Token stops working", "session ends early"] })),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    expect(aliasesOf(target, applied.createdIds[0]!)).toEqual(["token stops working", "session ends early"]);
  });

  it("are optional: a fact without any is accepted unchanged", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", newFact({})), { scaffoldRoot: target.root });
    expect(applied.ok).toBe(true);
    expect(aliasesOf(target, applied.createdIds[0]!)).toBeUndefined();
  });

  it("keep the other metadata keys a create-entry carries", () => {
    const target = scaffold();
    const applied = applyOperation(
      envelope(target, "create-entry", newFact({ aliases: ["one phrase"], metadata: { owner: "platform" } })),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    expect(target.entity(applied.createdIds[0]!).metadata).toEqual({ owner: "platform", aliases: ["one phrase"] });
  });

  it.each([
    ["more than eight", Array.from({ length: 9 }, (_, index) => `phrase ${index}`)],
    ["an empty phrase", ["fine", "   "]],
    ["a phrase over eighty characters", ["x".repeat(81)]],
    ["a non-string entry", ["fine", 3]],
    ["a value that is not an array", "just one"],
  ])("rejects %s", (_name, aliases) => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperation(envelope(target, "create-entry", newFact({ aliases })), { scaffoldRoot: target.root });
    expect(planned.ok).toBe(false);
    expect(codesOf(planned.diagnostics)).toContain("INVALID_OPERATION_PAYLOAD");
    expect(target.files()).toEqual(before);
  });

  it("applies the same bounds to aliases written through metadata", () => {
    const target = scaffold();
    const planned = planOperation(
      envelope(target, "create-entry", newFact({ metadata: { aliases: ["x".repeat(81)] } })),
      { scaffoldRoot: target.root },
    );
    expect(planned.ok).toBe(false);
    expect(codesOf(planned.diagnostics)).toContain("INVALID_OPERATION_PAYLOAD");
  });

  it("leaves a topic's alternative names to the topic rules", () => {
    const target = scaffold();
    const longName = "an alternative name that is deliberately longer than eighty characters so that it would fail a phrase bound";
    const applied = applyOperation(
      envelope(target, "create-entry", newFact({ type: "topic", title: "Auth", metadata: { aliases: [longName] } })),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    expect(aliasesOf(target, applied.createdIds[0]!)).toEqual([longName]);
  });

  it("update-entry replaces them and keeps the rest of the metadata", () => {
    const target = scaffold();
    const created = applyOperation(
      envelope(target, "create-entry", newFact({ aliases: ["first phrase"], metadata: { owner: "platform" } })),
      { scaffoldRoot: target.root },
    );
    const id = created.createdIds[0]!;
    const updated = applyOperation(envelope(target, "update-entry", { aliases: ["second phrase", "third phrase"] }, { entityId: id }), {
      scaffoldRoot: target.root,
    });
    expect(updated.ok).toBe(true);
    expect(target.entity(id).metadata).toEqual({ owner: "platform", aliases: ["second phrase", "third phrase"] });
  });

  it("update-entry with an empty list removes them", () => {
    const target = scaffold();
    const created = applyOperation(envelope(target, "create-entry", newFact({ aliases: ["first phrase"] })), {
      scaffoldRoot: target.root,
    });
    const id = created.createdIds[0]!;
    const updated = applyOperation(envelope(target, "update-entry", { aliases: [] }, { entityId: id }), {
      scaffoldRoot: target.root,
    });
    expect(updated.ok).toBe(true);
    expect(aliasesOf(target, id)).toBeUndefined();
  });

  it("update-entry works on a file-level entity too", () => {
    const target = scaffold();
    const updated = applyOperation(envelope(target, "update-entry", { aliases: ["whole system layout"] }, { entityId: ARCH }), {
      scaffoldRoot: target.root,
    });
    expect(updated.ok).toBe(true);
    expect(aliasesOf(target, ARCH)).toEqual(["whole system layout"]);
  });
});
