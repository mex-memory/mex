/**
 * Changed bodies that still say the same thing.
 *
 * Unit level: the layout-insensitive hash, the fact-aware diff, and the
 * resolver rows that use them. The integration half — real files, a real
 * graph, the body cache — is in `integration.test.ts`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bodyTokenHash, codeHash, layoutHash, prepareCodeHashing } from "../../../graph/code-hash.js";
import { createGroundingEvidence } from "../../../graph/grounding-evidence.js";
import { factAnchors, factDrift } from "../fact-drift.js";
import { resolveGrounding } from "../resolve.js";
import type { ChangeEvidence, GroundedNode, GroundingGraph } from "../adapter.js";
import type { WikiGrounding } from "../../model/grounding.js";

beforeAll(async () => {
  await prepareCodeHashing();
});

describe("layoutHash", () => {
  const before = "export class Hono<\n  E = 1,\n  P extends string = \"/\"\n> {\n  run() { return f(a, b); }\n}\n";
  const after = "export class Hono<\n  E = 1,\n  P extends string = '/',\n> {\n  run() { return f(a, b,); };\n}\n";

  it("ignores trailing commas, semicolons and quote style", () => {
    expect(codeHash("a.ts", before, 1, 6)).not.toBe(codeHash("a.ts", after, 1, 6));
    expect(layoutHash("a.ts", before, 1, 6)).toBe(layoutHash("a.ts", after, 1, 6));
  });

  it("still sees a changed literal, identifier or operator", () => {
    expect(layoutHash("a.ts", before, 1, 6)).not.toBe(layoutHash("a.ts", before.replace('"/"', '"/x"'), 1, 6));
    expect(layoutHash("a.ts", before, 1, 6)).not.toBe(layoutHash("a.ts", before.replace("f(a, b)", "f(b, a)"), 1, 6));
    expect(layoutHash("a.ts", before, 1, 6)).not.toBe(layoutHash("a.ts", before.replace("f(a, b)", "f(a - b)"), 1, 6));
  });

  it("hashes a method body on its own by parsing it inside a class", () => {
    const method = "  #add(method: string) {\n    return method.toUpperCase()\n  }";
    expect(bodyTokenHash("a.ts", method, true)).not.toBeNull();
    expect(bodyTokenHash("a.ts", method, true)).toBe(bodyTokenHash("a.ts", `${method.replace("()", "();")}`, true));
  });
});

describe("factAnchors", () => {
  it("collects identifiers, calls, private names, literals and numbers, not prose", () => {
    const anchors = factAnchors("c.redirect() defaults to status 302 and verify() uses 'HS256' via #req in parseBody.");
    expect(anchors).toEqual(expect.arrayContaining(["redirect", "302", "verify", "HS256", "#req", "parseBody"]));
    expect(anchors).not.toContain("defaults");
    expect(anchors).not.toContain("status");
  });
});

describe("factDrift", () => {
  const old = [
    "function redirect(location, status) {",
    "  const loc = encode(location)",
    "  log('redirecting')",
    "  trace()",
    "  audit()",
    "  return this.newResponse(null, status ?? 302, { Location: loc })",
    "}",
  ].join("\n");

  it("reports nearby when the change is away from every line the fact names", () => {
    const changed = old.replace("log('redirecting')", "log('redirect requested')");
    const fact = "redirect() responds with status 302 by default.";
    // `redirect` only names the declaration, leaving `302` alone: too little to locate the fact.
    expect(factDrift(fact, old, changed).kind).toBe("touched");
    expect(factDrift(fact, old, old.replace("  trace()\n", "  trace(302)\n")).kind).toBe("touched");
    const far = "c.newResponse is called with 302 when no status is given.";
    expect(factDrift(far, old, changed)).toEqual({ kind: "nearby", anchors: ["newResponse", "302"] });
    expect(factDrift("It replies with 302.", old, changed).kind).toBe("touched"); // one anchor is not enough
  });

  it("reports touched when a named literal changes", () => {
    const changed = old.replace("302", "307");
    expect(factDrift("The default status is 302.", old, changed).kind).toBe("touched");
  });

  it("reports touched when an anchor disappears anywhere", () => {
    const changed = old.replace("this.newResponse(", "this.respond(");
    expect(factDrift("It builds the reply with newResponse.", old, changed).kind).toBe("touched");
  });

  it("widens a change by context lines, so a list gaining an element is touched", () => {
    const list = ["const METHODS = [", "  'get',", "  'post',", "  'put',", "] as const"].join("\n");
    const grown = list.replace("  'put',", "  'put',\n  'query',");
    expect(factDrift("METHODS lists get, post and put.", list, grown).kind).toBe("touched");
  });

  it("does not anchor a fact to the symbol's own declaration", () => {
    const parse = ["export const parse = (cookie) => {", "  const out = {}", "  for (const pair of split(cookie)) {", "    out[pair.name] = pair.value", "  }", "  return out", "}"].join("\n");
    const changed = parse.replace("    out[pair.name] = pair.value", "    out[pair.name] ??= pair.value");
    expect(factDrift("parse() returns the last value when a name repeats.", parse, changed).kind).toBe("touched");
  });

  it("fails safe without anchors", () => {
    expect(factDrift("It works as documented.", old, `${old}\n`).kind).toBe("touched");
  });
});

const NODE = "method:0123456789abcdef";

function graphWith(evidence: ChangeEvidence | null, current = "body-2"): GroundingGraph & { remembered: string[] } {
  const remembered: string[] = [];
  const node: GroundedNode = { id: NODE, bodyHash: current, filePath: "src/a.ts", startLine: 1, endLine: 5 };
  return {
    remembered,
    getNode: (id) => (id === NODE ? node : null),
    getFingerprint: () => "mh:64:00",
    reconcile: () => ({ kind: "GONE" }),
    getBaselineSource: () => {
      throw new Error("resolution consulted the cached baseline");
    },
    explainChange: () => evidence,
    rememberBody: (id, hash) => {
      remembered.push(`${id}:${hash}`);
    },
  };
}

const GROUNDED: WikiGrounding = { node: NODE, fingerprint: "mh:64:00", bodyHash: "body-1" };

describe("resolution of a changed body with evidence", () => {
  it("remembers a matching body", () => {
    const graph = graphWith(null, "body-1");
    expect(resolveGrounding(GROUNDED, graph).health).toBe("fresh");
    expect(graph.remembered).toEqual([`${NODE}:body-1`]);
  });

  it("is fresh, with a note, when only comments changed", () => {
    const resolution = resolveGrounding(GROUNDED, graphWith({ commentOnly: true, layoutOnly: true, oldBody: null, newBody: "x" }));
    expect(resolution).toMatchObject({ health: "fresh", drift: { kind: "comment-only" } });
  });

  it("is fresh, with a note, when only layout changed", () => {
    const resolution = resolveGrounding(GROUNDED, graphWith({ commentOnly: false, layoutOnly: true, oldBody: null, newBody: "x" }));
    expect(resolution).toMatchObject({ health: "fresh", drift: { kind: "layout-only" } });
  });

  it("is fresh as changed-nearby only with the fact and both bodies", () => {
    const evidence = {
      commentOnly: false, layoutOnly: false,
      oldBody: "alpha()\nbeta()\ngamma()\ndelta()\nepsilon()\nzeta()", newBody: "alpha()\nbeta()\ngamma()\ndelta()\nepsilon()\neta()",
    };
    expect(resolveGrounding(GROUNDED, graphWith(evidence)).health).toBe("changed");
    expect(resolveGrounding(GROUNDED, graphWith(evidence), { fact: "It calls beta() then gamma()." })).toMatchObject({
      health: "fresh",
      drift: { kind: "changed-nearby", anchors: ["beta", "gamma"] },
    });
    expect(resolveGrounding(GROUNDED, graphWith(evidence), { fact: "It ends with zeta()." }).health).toBe("changed");
  });

  it("stays changed without evidence", () => {
    expect(resolveGrounding(GROUNDED, graphWith(null)).health).toBe("changed");
  });
});

describe("grounding evidence over real files", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("explains a comment-only and a layout-only edit against a remembered body", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-evidence-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    const write = (text: string): void => writeFileSync(join(root, "src", "a.ts"), text);
    const bodyHash = (text: string): string => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
    const v1 = "export function f(a: string) {\n  return g(a, \"x\")\n}\n";
    let current = v1;
    write(current);
    const evidence = createGroundingEvidence({
      projectRoot: root,
      getNode: () => ({ filePath: "src/a.ts", startLine: 1, endLine: 3, bodyHash: bodyHash(current.split("\n").slice(0, 3).join("\n")) }),
    });
    const committed = { bodyHash: bodyHash(v1.split("\n").slice(0, 3).join("\n")) };
    evidence.rememberBody(NODE, committed.bodyHash);

    current = "export function f(a: string) {\n  return g(a, \"x\") // why\n}\n";
    write(current);
    expect(evidence.explainChange(committed, NODE)).toMatchObject({ commentOnly: true, layoutOnly: true });

    current = "export function f(a: string) {\n  return g(a, 'x',);\n}\n";
    write(current);
    expect(evidence.explainChange(committed, NODE)).toMatchObject({ commentOnly: false, layoutOnly: true });

    current = "export function f(a: string) {\n  return g(a, 'y')\n}\n";
    write(current);
    expect(evidence.explainChange(committed, NODE)).toMatchObject({ commentOnly: false, layoutOnly: false });
  });
});
