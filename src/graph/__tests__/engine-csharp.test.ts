import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../engine-impl.js";
import type { GraphEngine } from "../engine.js";

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-csharp-graph-"));
  writeFileSync(join(root, "sample.cs"), `
namespace Example;
class A : B {
  void Start(B other) { other.Run(); base.Run(); StaticB.Run(); GetOther().Run(); }
  B GetOther() => new B();
  void Local() { Run(); this.Run(); this . Run(); this /* comment */.Run(); }
  void Run() {}
  static int Init() => 1;
  int value = Init();
  public int this[int index] => Init();
}
class B { public void Run() {} }
class StaticB { public static void Run() {} }
class C : B { void LocalShadow() { void Run() {} this.Run(); } }
interface IRoot {}
interface IChild : IRoot {}
`);
  writeFileSync(join(root, "qualified-types.cs"), `
class Resource {}
namespace Collisions {
  class Base {}
  interface IContract {}
  class QualifiedChild : Elsewhere.Base {}
  class GlobalChild : global::Elsewhere.Base {}
  class QualifiedImplements : Base, Elsewhere.IContract {}
  class GlobalImplements : Base, global::Elsewhere.IContract {}
  class LocalChild : Base, IContract {}
  class Factory {
    class Resource {}
    object QualifiedCreate() => new Elsewhere.Resource();
    object GlobalCreate() => new global::Elsewhere.Resource();
    object GlobalRootCreate() => new global::Resource();
    object LocalCreate() => new Resource();
  }
}
namespace Elsewhere {
  class Base {}
  interface IContract {}
  class Resource {}
}
`);
  writeFileSync(join(root, "recursion.cs"), `
namespace Recursion;
class Overloaded {
  void Run() { Run(); this.Run(); }
  void Run(int count) {}
}
class Unique {
  void Repeat() { Repeat(); this.Repeat(); }
}
`);
  writeFileSync(join(root, "lib.cs"), `
namespace Lib.Core;
public class Sink { public static void Emit() {} }
`);
  writeFileSync(join(root, "app.cs"), `
using Lib.Core;
namespace App;
class User : Sink { void Go() { Sink.Emit(); } }
`);
  writeFileSync(join(root, "other.cs"), `
namespace Other;
class NoUsing : Sink { void Go() { Sink.Emit(); } }
`);
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

function symbol(qualifiedName: string, signature?: string) {
  const matches = engine.searchNodes(qualifiedName).filter((node) =>
    node.qualifiedName === qualifiedName && (signature === undefined || node.signature === signature),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("C# graph persistence and resolution", () => {
  it("indexes file-scoped declarations once with their namespace", () => {
    expect(engine.searchNodes("Run").filter((node) => node.name === "Run" && node.filePath === "sample.cs")
      .map((node) => node.qualifiedName).sort())
      .toEqual(["Example.A.Run", "Example.B.Run", "Example.C.LocalShadow.Run", "Example.StaticB.Run"]);
  });

  it("keeps unproven receivers unresolved despite same-named lexical methods", () => {
    const caller = symbol("Example.A.Start");
    expect(engine.getCallees(caller.id).map((node) => node.qualifiedName).sort())
      .toEqual(["Example.A.GetOther", "Example.StaticB.Run"]);
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(db.prepare(`
        SELECT reference_name, receiver, status, target_id, confidence
        FROM unresolved_refs WHERE from_node_id = ? AND reference_name LIKE '%.Run'
        ORDER BY reference_name
      `).all(caller.id)).toEqual([
        { reference_name: "GetOther().Run", receiver: "GetOther()", status: "unresolved", target_id: null, confidence: 0 },
        { reference_name: "base.Run", receiver: "base", status: "unresolved", target_id: null, confidence: 0 },
        { reference_name: "other.Run", receiver: "other", status: "unresolved", target_id: null, confidence: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("still resolves unqualified and this calls in the lexical type", () => {
    const target = symbol("Example.A.Run");
    const calls = engine.getOutgoing(symbol("Example.A.Local").id, ["calls"]);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.node.id).toBe(target.id);
      expect(call.edge).toMatchObject({ resolutionMethod: "lexical-scope", confidence: 1 });
    }
  });

  it("does not bind an explicit this receiver to a shadowing local function", () => {
    expect(engine.getCallees(symbol("Example.C.LocalShadow").id)).toEqual([]);
  });

  it("resolves field initializer and indexer calls from their owning symbols", () => {
    for (const owner of ["Example.A.value", "Example.A.this"]) {
      expect(engine.getCallees(symbol(owner).id).map((node) => node.qualifiedName))
        .toEqual(["Example.A.Init"]);
    }
  });

  it("persists interface inheritance as extends", () => {
    const child = symbol("Example.IChild");
    expect(engine.getOutgoing(child.id, ["extends"]).map((neighbor) => neighbor.node.id))
      .toEqual([symbol("Example.IRoot").id]);
    expect(engine.getOutgoing(child.id, ["implements"])).toEqual([]);
  });

  it("binds qualified type references through their namespace, never to same-named lexical types", () => {
    for (const [owner, kind, target] of [
      ["Collisions.QualifiedChild", "extends", "Elsewhere.Base"],
      ["Collisions.GlobalChild", "extends", "Elsewhere.Base"],
      ["Collisions.QualifiedImplements", "implements", "Elsewhere.IContract"],
      ["Collisions.GlobalImplements", "implements", "Elsewhere.IContract"],
      ["Collisions.Factory.QualifiedCreate", "instantiates", "Elsewhere.Resource"],
      ["Collisions.Factory.GlobalCreate", "instantiates", "Elsewhere.Resource"],
      ["Collisions.Factory.GlobalRootCreate", "instantiates", "Resource"],
    ] as const) {
      expect(engine.getOutgoing(symbol(owner).id, [kind]).map((neighbor) => neighbor.node.qualifiedName), owner)
        .toEqual([target]);
    }
  });

  it("binds types and static calls across files only through a using directive", () => {
    const sink = symbol("Lib.Core.Sink");
    expect(engine.getOutgoing(symbol("App.User").id, ["extends"]).map((neighbor) => neighbor.node.id)).toEqual([sink.id]);
    expect(engine.getCallees(symbol("App.User.Go").id).map((node) => node.qualifiedName)).toEqual(["Lib.Core.Sink.Emit"]);
    expect(engine.getOutgoing(symbol("Other.NoUsing").id, ["extends"])).toEqual([]);
    expect(engine.getCallees(symbol("Other.NoUsing.Go").id)).toEqual([]);
  });

  it("still resolves unqualified inheritance and construction in lexical scope", () => {
    const child = symbol("Collisions.LocalChild");
    expect(engine.getOutgoing(child.id, ["extends"]).map((neighbor) => neighbor.node.id))
      .toEqual([symbol("Collisions.Base").id]);
    expect(engine.getOutgoing(child.id, ["implements"]).map((neighbor) => neighbor.node.id))
      .toEqual([symbol("Collisions.IContract").id]);
    expect(engine.getOutgoing(symbol("Collisions.Factory.LocalCreate").id, ["instantiates"])
      .map((neighbor) => neighbor.node.id))
      .toEqual([symbol("Collisions.Factory.Resource").id]);
  });

  it("does not discard the recursive overload before deciding whether a call is ambiguous", () => {
    const caller = symbol("Recursion.Overloaded.Run", "()");
    expect(engine.getCallees(caller.id)).toEqual([]);
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      const references = db.prepare(`
        SELECT reference_name, status, target_id, confidence
        FROM unresolved_refs WHERE from_node_id = ? AND reference_kind = 'calls'
        ORDER BY reference_name
      `).all(caller.id) as Array<{ reference_name: string; status: string; target_id: string | null; confidence: number }>;
      expect(references.map((reference) => reference.reference_name)).toEqual(["Run", "this.Run"]);
      for (const reference of references) {
        expect(["unresolved", "ambiguous"]).toContain(reference.status);
        expect(reference.target_id).toBeNull();
        expect(reference.confidence).toBeLessThan(1);
      }
    } finally {
      db.close();
    }
  });

  it("resolves unique recursive calls to their own method, including explicit this calls", () => {
    const caller = symbol("Recursion.Unique.Repeat");
    const calls = engine.getOutgoing(caller.id, ["calls"]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.node.id).toBe(caller.id);
      expect(call.edge).toMatchObject({ resolutionMethod: "lexical-scope", confidence: 1 });
    }
  });
});
