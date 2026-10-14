import { describe, expect, it } from "vitest";
import { resolveReferences } from "../resolution/resolver.js";
import type { GraphNode, Language } from "../types.js";
import type { UnresolvedRefRecord } from "../db/store.js";

function node(id: string, name: string, language: Language, containerId = "file:fixture"): GraphNode {
  return {
    id, name, kind: "function", qualifiedName: name, language, containerId,
    filePath: "fixture", startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 1,
  };
}

function reference(source: GraphNode, name: string, receiver?: string): UnresolvedRefRecord {
  return {
    fromNodeId: source.id, referenceName: name, referenceKind: "calls", receiver,
    filePath: source.filePath, language: source.language, line: 1, column: 0,
  };
}

describe("proven lexical recursive calls", () => {
  it.each(["python", "rust"] as const)("keeps the unique %s caller as a recursive target", (language) => {
    const recurse = node("function:recurse", "recurse", language);
    const edges = resolveReferences([recurse], [reference(recurse, "recurse")]);
    expect(edges).toEqual([expect.objectContaining({ source: recurse.id, target: recurse.id, kind: "calls" })]);
  });

  it.each(["python", "rust", "csharp"] as const)("does not pick a sibling from an ambiguous %s recursion", (language) => {
    const recurse = node("function:recurse", "recurse", language);
    const sibling = { ...recurse, id: "function:sibling" };
    expect(resolveReferences([recurse, sibling], [reference(recurse, "recurse")])).toEqual([]);
  });

  it("does not infer the type of an arbitrary Rust receiver from a lexical method name", () => {
    const run = { ...node("method:run", "run", "rust", "class:worker"), kind: "method" as const };
    const inspect = { ...run, id: "method:inspect", name: "inspect", qualifiedName: "inspect" };
    expect(resolveReferences([run, inspect], [reference(inspect, "other.run", "other")])).toEqual([]);
    expect(resolveReferences([run, inspect], [reference(inspect, "self.run", "self")]))
      .toEqual([expect.objectContaining({ source: inspect.id, target: run.id, kind: "calls" })]);
  });
  it("never reads a super, foreign-receiver, or bare call inside a method as recursion", () => {
    const save = { ...node("method:save", "save", "python", "class:model"), kind: "method" as const };
    for (const [name, receiver] of [["super().save", "super()"], ["other.save", "other"], ["save", undefined]] as const) {
      expect(resolveReferences([save], [reference(save, name, receiver)]), name).toEqual([]);
    }
    expect(resolveReferences([save], [reference(save, "self.save", "self")]))
      .toEqual([expect.objectContaining({ source: save.id, target: save.id, kind: "calls" })]);
  });
});
