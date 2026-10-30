/**
 * Code named by file and symbol or line, resolved inside the operation.
 *
 * The graph here is a fake shaped like the real extractor's output (a probe
 * of a TypeScript and a Python file): qualified names are `::`-separated,
 * TypeScript overloads are one node, a nested function is `outer::inner`, and
 * only declarations with a body carry a body hash. The real-graph half of this
 * contract is `test/wiki-apply-batch.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { applyOperation } from "../apply.js";
import { planOperation } from "../plan.js";
import type { CodeDeclaration, GroundingGraph } from "../../grounding/adapter.js";
import { normalizeReferencePath, resolveCodeReference } from "../../grounding/code-reference.js";
import { validateGroundingTarget } from "../../model/grounding.js";
import { rootContext } from "../../model/validate.js";
import { GATEWAY, codesOf, envelope, makeScaffold, type Scaffold } from "./helpers.js";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const decl = (n: number, kind: string, qualifiedName: string, startLine: number, endLine: number, hasBody = true, signature?: string): CodeDeclaration & { filePath: string } => ({
  id: `${kind}:${hex(n)}`,
  kind,
  name: qualifiedName.split("::").pop()!,
  qualifiedName,
  startLine,
  endLine,
  hasBody,
  filePath: "",
  ...(signature === undefined ? {} : { signature }),
});

const ROUTER = [
  decl(1, "file", "src/router.ts", 1, 30, false),
  decl(2, "class", "Router", 2, 9, true, "(): Router"),
  decl(3, "method", "Router::add", 3, 5, true, "(method: string, path: string): void"),
  decl(4, "method", "Router::match", 6, 8, true, "(path: string): null | string"),
  decl(5, "function", "parseBody", 10, 15, true, "(input: number): string | (input: string): string"),
  decl(6, "function", "helper", 19, 22),
  decl(7, "function", "helper::inner", 20, 20),
  decl(8, "namespace", "Util", 23, 25, false),
  decl(9, "function", "Util::add", 24, 24, true, "(a: number, b: number): number"),
  decl(10, "type_alias", "Options", 26, 26, false),
  decl(11, "function", "twice", 27, 28),
  decl(12, "function", "twice", 29, 30),
].map((entry) => ({ ...entry, filePath: "src/router.ts" }));

const APP = [
  decl(20, "file", "src/app.py", 1, 12, false),
  decl(21, "class", "Service", 2, 8),
  decl(22, "method", "Service::start", 3, 5, true, "(self, port)"),
  decl(23, "method", "Service::stop", 7, 8, true, "(self)"),
  decl(24, "function", "start", 10, 11, true, "(x)"),
].map((entry) => ({ ...entry, filePath: "src/app.py" }));

const ALL = [...ROUTER, ...APP];
const BODY = (id: string) => `${id.split(":")[1]!.padStart(64, "0")}`;
const FINGERPRINT = (id: string) => `mh:64:${id.split(":")[1]!.slice(0, 8)}`;

const graph: GroundingGraph = {
  getNode: (id) => {
    const found = ALL.find((entry) => entry.id === id);
    return found === undefined ? null : {
      id: found.id,
      bodyHash: found.hasBody ? BODY(found.id) : null,
      filePath: found.filePath,
      startLine: found.startLine,
      endLine: found.endLine,
    };
  },
  getFingerprint: (id) => (ALL.some((entry) => entry.id === id) ? FINGERPRINT(id) : null),
  reconcile: () => null,
  getBaselineSource: () => {
    throw new Error("a write must not read the cached baseline");
  },
  declarationsInFile: (path) => {
    const found = ALL.filter((entry) => entry.filePath === path);
    return found.length === 0 ? null : found;
  },
};

const resolve = (reference: { file: string; symbol?: string; line?: number }) => resolveCodeReference(reference, graph);
const idOf = (result: ReturnType<typeof resolve>) => (result.ok ? result.node.id : result.diagnostic.code);
const id = (n: number, kind: string) => `${kind}:${hex(n)}`;

describe("resolving a symbol", () => {
  it("finds a top-level declaration by its name", () => {
    expect(idOf(resolve({ file: "src/router.ts", symbol: "parseBody" }))).toBe(id(5, "function"));
  });

  it("accepts a qualified name in any of the usual separators", () => {
    for (const symbol of ["Router.add", "Router::add", "Router#add", " Router.add "]) {
      expect(idOf(resolve({ file: "src/router.ts", symbol })), symbol).toBe(id(3, "method"));
    }
    expect(idOf(resolve({ file: "src/router.ts", symbol: "helper.inner" }))).toBe(id(7, "function"));
  });

  it("accepts a leading module name, as a Python reader would write it", () => {
    expect(idOf(resolve({ file: "src/app.py", symbol: "app.start" }))).toBe(id(24, "function"));
    expect(idOf(resolve({ file: "src/app.py", symbol: "app.Service.stop" }))).toBe(id(23, "method"));
    expect(idOf(resolve({ file: "src/router.ts", symbol: "router.parseBody" }))).toBe(id(5, "function"));
  });

  it("matches an unqualified method name when only one declaration ends with it", () => {
    expect(idOf(resolve({ file: "src/router.ts", symbol: "match" }))).toBe(id(4, "method"));
  });

  it("prefers the declaration whose whole qualified name is the symbol", () => {
    // `start` is the module function; the method is `Service.start`.
    expect(idOf(resolve({ file: "src/app.py", symbol: "start" }))).toBe(id(24, "function"));
    expect(idOf(resolve({ file: "src/app.py", symbol: "Service.start" }))).toBe(id(22, "method"));
  });

  it("refuses a name several declarations end with, listing every candidate", () => {
    const result = resolve({ file: "src/router.ts", symbol: "add" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("GROUNDING_AMBIGUOUS");
    expect(result.diagnostic.message).toContain(id(3, "method"));
    expect(result.diagnostic.message).toContain(id(9, "function"));
    expect(result.diagnostic.message).toContain("Router.add (method, lines 3-5, (method: string, path: string): void)");
    expect(result.diagnostic.message).toContain("Util.add");
  });

  it("refuses two declarations with the same qualified name", () => {
    const result = resolve({ file: "src/router.ts", symbol: "twice" });
    expect(idOf(result)).toBe("GROUNDING_AMBIGUOUS");
    expect(result.ok ? "" : result.diagnostic.message).toContain("lines 27-28");
    expect(result.ok ? "" : result.diagnostic.message).toContain("lines 29-30");
  });

  it("refuses an unknown name with the nearest declarations", () => {
    const result = resolve({ file: "src/router.ts", symbol: "parseBdy" });
    expect(idOf(result)).toBe("GROUNDING_NOT_FOUND");
    expect(result.ok ? "" : result.diagnostic.message).toContain("Nearest: parseBody");
  });

  it("lists what the file declares when no name is close, instead of saying it declares nothing", () => {
    const result = resolve({ file: "src/router.ts", symbol: "completelyUnrelatedName" });
    expect(idOf(result)).toBe("GROUNDING_NOT_FOUND");
    const message = result.ok ? "" : result.diagnostic.message;
    expect(message).toContain("No similar name; the file declares: ");
    expect(message).toContain("parseBody");
    expect(message).not.toContain("declares no function");
  });

  it("refuses a declaration with no body, saying why", () => {
    const result = resolve({ file: "src/router.ts", symbol: "Options" });
    expect(idOf(result)).toBe("GROUNDING_NOT_FOUND");
    expect(result.ok ? "" : result.diagnostic.message).toContain("no body");
  });
});

describe("resolving a line", () => {
  it("takes the innermost named declaration with a body around the line", () => {
    expect(idOf(resolve({ file: "src/router.ts", line: 4 }))).toBe(id(3, "method"));
    expect(idOf(resolve({ file: "src/router.ts", line: 2 }))).toBe(id(2, "class"));
    expect(idOf(resolve({ file: "src/router.ts", line: 20 }))).toBe(id(7, "function"));
    expect(idOf(resolve({ file: "src/router.ts", line: 21 }))).toBe(id(6, "function"));
    // The namespace has no body; the function on its line does.
    expect(idOf(resolve({ file: "src/router.ts", line: 24 }))).toBe(id(9, "function"));
    expect(idOf(resolve({ file: "src/app.py", line: 11 }))).toBe(id(24, "function"));
  });

  it("refuses a line outside every declaration, with the nearest ones", () => {
    const result = resolve({ file: "src/router.ts", line: 17 });
    expect(idOf(result)).toBe("GROUNDING_NOT_FOUND");
    expect(result.ok ? "" : result.diagnostic.message).toContain("Nearest:");
    expect(result.ok ? "" : result.diagnostic.message).toContain("parseBody");
  });
});

describe("the file a reference names", () => {
  it("tolerates ./ and backslashes", () => {
    expect(normalizeReferencePath("./src\\router.ts")).toBe("src/router.ts");
    expect(normalizeReferencePath("src//router.ts")).toBe("src/router.ts");
    expect(idOf(resolve({ file: ".\\src\\router.ts", symbol: "parseBody" }))).toBe(id(5, "function"));
  });

  it("refuses paths that leave the repository or are absolute", () => {
    for (const file of ["../router.ts", "/src/router.ts", "C:/src/router.ts", "src/../router.ts"]) {
      expect(normalizeReferencePath(file), file).toBeNull();
      expect(idOf(resolve({ file, symbol: "parseBody" })), file).toBe("GROUNDING_NOT_FOUND");
    }
  });

  it("refuses a file the graph does not hold", () => {
    const result = resolve({ file: "src/missing.ts", symbol: "parseBody" });
    expect(idOf(result)).toBe("GROUNDING_NOT_FOUND");
    expect(result.ok ? "" : result.diagnostic.message).toContain("src/missing.ts is not in the code graph");
  });

  it("cannot resolve anything without a graph, or with one that cannot list a file", () => {
    expect(resolveCodeReference({ file: "src/router.ts", symbol: "parseBody" }, null).ok).toBe(false);
    const { declarationsInFile: _omitted, ...narrow } = graph;
    const result = resolveCodeReference({ file: "src/router.ts", symbol: "parseBody" }, narrow);
    expect(result.ok ? "" : result.diagnostic.code).toBe("GROUNDING_UNVERIFIED");
  });
});

describe("the reference's own shape", () => {
  const check = (value: unknown) => validateGroundingTarget(value, rootContext());

  it("accepts file with symbol, file with line, and a node", () => {
    expect(check({ file: "src/a.ts", symbol: "f" }).ok).toBe(true);
    expect(check({ file: "src/a.ts", line: 3, reason: "why" }).ok).toBe(true);
    expect(check({ node: "function:aaaaaaaa" }).ok).toBe(true);
  });

  it("refuses every malformed or mixed form", () => {
    for (const value of [
      { file: "src/a.ts" },
      { file: "src/a.ts", symbol: "f", line: 3 },
      { symbol: "f" },
      { file: "", symbol: "f" },
      { file: "src/a.ts", line: 0 },
      { file: "src/a.ts", line: 1.5 },
      { file: "src/a.ts", symbol: "f", fingerprint: "mh:64:00" },
      { node: "function:aaaaaaaa", symbol: "f" },
      { node: "function:aaaaaaaa", file: "src/a.ts", line: 3 },
    ]) {
      const result = check(value);
      expect(result.ok, JSON.stringify(value)).toBe(false);
      expect(codesOf(result.diagnostics), JSON.stringify(value)).toContain("MALFORMED_GROUNDING");
    }
  });
});

const scaffolds: Scaffold[] = [];
function scaffold(): Scaffold {
  const made = makeScaffold();
  scaffolds.push(made);
  return made;
}
afterEach(() => {
  while (scaffolds.length > 0) scaffolds.pop()!.dispose();
});

function newFact(groundsTo: unknown[]): Record<string, unknown> {
  return {
    file: "context/architecture.md",
    insertAt: { at: "end-of-file" },
    type: "fact",
    title: "Routes register through add",
    body: "`Router.add()` stores the method and path.",
    headingDepth: 2,
    groundsTo,
  };
}

describe("an operation that names code by file", () => {
  it("writes exactly what naming the node by id writes", () => {
    const byName = scaffold();
    const byId = scaffold();
    const named = applyOperation(envelope(byName, "create-entry", newFact([{ file: "src/router.ts", symbol: "Router.add" }])), { scaffoldRoot: byName.root, graph });
    const direct = applyOperation(envelope(byId, "create-entry", newFact([{ node: id(3, "method") }])), { scaffoldRoot: byId.root, graph });
    expect(named.ok).toBe(true);
    expect(direct.ok).toBe(true);
    const expected = [{ node: id(3, "method"), fingerprint: FINGERPRINT(id(3, "method")), bodyHash: BODY(id(3, "method")), file: "src/router.ts" }];
    expect(byName.entity(named.createdIds[0]!).groundsTo).toEqual(expected);
    expect(byId.entity(direct.createdIds[0]!).groundsTo).toEqual(expected);
    // Nothing of the reference itself reaches the Markdown.
    expect(byName.read("context/architecture.md")).not.toContain("symbol");
  });

  it("keeps the reason a reference carries", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", newFact([{ file: "src/router.ts", line: 4, reason: "registration" }])), { scaffoldRoot: target.root, graph });
    expect(applied.ok).toBe(true);
    expect(target.entity(applied.createdIds[0]!).groundsTo[0]).toMatchObject({ node: id(3, "method"), reason: "registration" });
  });

  it("reports every unresolvable reference of one operation and writes nothing", () => {
    const target = scaffold();
    const before = target.files();
    const refused = applyOperation(envelope(target, "create-entry", newFact([
      { file: "src/router.ts", symbol: "add" },
      { file: "src/router.ts", symbol: "nope" },
      { file: "src/router.ts", symbol: "parseBody" },
    ])), { scaffoldRoot: target.root, graph });
    expect(refused.ok).toBe(false);
    expect(codesOf(refused.diagnostics)).toEqual(expect.arrayContaining(["GROUNDING_AMBIGUOUS", "GROUNDING_NOT_FOUND"]));
    expect(refused.diagnostics.find((entry) => entry.code === "GROUNDING_AMBIGUOUS")?.path).toBe("payload.groundsTo[0]");
    expect(refused.diagnostics.find((entry) => entry.code === "GROUNDING_NOT_FOUND")?.path).toBe("payload.groundsTo[1]");
    expect(target.files()).toEqual(before);
  });

  it("set-grounding resolves a reference the same way", () => {
    const target = scaffold();
    const applied = applyOperation(
      envelope(target, "set-grounding", { groundsTo: [{ file: "src/app.py", symbol: "Service.stop" }] }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root, graph },
    );
    expect(applied.ok).toBe(true);
    expect(target.entity(GATEWAY).groundsTo).toEqual([
      { node: id(23, "method"), fingerprint: FINGERPRINT(id(23, "method")), bodyHash: BODY(id(23, "method")), file: "src/app.py" },
    ]);
  });

  it("is refused for adoption, which never consults the graph", () => {
    const target = scaffold();
    const planned = planOperation(envelope(target, "create-entry", {
      file: "context/architecture.md",
      adopt: { at: "heading", ordinal: 1, text: "Gateway" },
      type: "component",
      title: "Gateway",
      groundsTo: [{ file: "src/router.ts", symbol: "parseBody" }],
    }), { scaffoldRoot: target.root, graph });
    expect(planned.ok).toBe(false);
    expect(codesOf(planned.diagnostics)).toContain("INVALID_OPERATION_PAYLOAD");
  });

  it("replays by opId: the same reference is a no-op the second time", () => {
    const target = scaffold();
    const op = envelope(target, "create-entry", newFact([{ file: "./src/router.ts", symbol: "parseBody" }]), { opId: "op-replay-ref" });
    const first = applyOperation(op, { scaffoldRoot: target.root, graph });
    const after = target.files();
    const second = applyOperation(op, { scaffoldRoot: target.root, graph });
    expect(first.ok && second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.createdIds).toEqual(first.createdIds);
    expect(target.files()).toEqual(after);
  });
});
