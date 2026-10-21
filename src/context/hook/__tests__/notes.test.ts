import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphNodeRow, GraphReader } from "../../graph-reader.js";
import type { ContextEntity, ContextIndex } from "../../types.js";
import { composeEdit, composeGrep, composeRead, findTouched, firstBodyLine, seeAlso, type EventContext } from "../events.js";
import { afterKnowledge, composeGraphEdit, composeGraphSearch } from "../graph.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs(); });
const node = (id: string, overrides: Partial<GraphNodeRow> = {}): GraphNodeRow =>
  ({ id, name: `calculate${id}`, file: "src/core.ts", start: 10, end: 30, bodyHash: "hash", ...overrides });
const fact = (id: string, n: GraphNodeRow, overrides: Partial<ContextEntity> = {}): ContextEntity => ({
  id, type: "fact", title: `Claim ${id}`, body: "Opening evidence. ".repeat(30) + "The deciding claim is at the end.",
  aliases: [], file: "context/claims.md", line: 1, level: 2,
  groundings: [{ node: n.id, file: n.file, bodyHash: "hash" }], code: [n.file],
  symbols: [{ node: n.id, name: n.name, file: n.file, start: n.start, end: n.end, bodyHash: "hash" }], ...overrides,
});
function context(nodes: GraphNodeRow[], entities: ContextEntity[] = []): EventContext {
  const root = mkdtempSync(join(tmpdir(), "mex-notes-")); roots.push(root);
  const reader: GraphReader = {
    identity: () => "snapshot", close: () => {}, callerCount: () => 0,
    nodes: ids => new Map(nodes.filter(n => ids.includes(n.id)).map(n => [n.id, n])),
    enclosing: (file, line) => nodes.filter(n => n.file === file && n.start <= line && n.end >= line).sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null,
    callers: () => [], callees: () => [], inRange: () => [],
    exactName: (name, limit, files) => nodes.filter(n => n.name === name && (!files || files.includes(n.file))).slice(0, limit),
    exactNameCount: (name, files) => nodes.filter(n => n.name === name && (!files || files.includes(n.file))).length,
  };
  return { projectRoot: root, localDir: join(root, ".mex/local"), head: null,
    index: { entities } as ContextIndex, reader, shown: new Set() };
}

describe("small notes", () => {
  it("drops factless hits before prose, caps at two facts, and keeps deciding tails", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(String(i), { start: i * 40 + 1, end: i * 40 + 20 }));
    const ctx = context(nodes, nodes.slice(0, 3).map(n => fact(`mx_${n.id}`, n)));
    const out = composeGrep(ctx, nodes.map(n => ({ file: n.file, line: n.start })))!;
    expect(out.ids).toHaveLength(2);
    expect(out.text.length).toBeLessThanOrEqual(1200);
    expect(out.text.match(/The deciding claim is at the end\./g)).toHaveLength(2);
    expect(out.text).not.toContain("calculate11");
    expect(out.text).not.toContain("callers:");
    expect(out.text).toContain("read code bodies");
    expect(out.text).toContain("location");
  });

  it("ignores giant groundings for whole-file, ranged, and file-only search overlap", () => {
    const giant = node("giant", { end: 1217 });
    const ctx = context([giant], [fact("mx_giant", giant)]);
    expect(composeRead(ctx, { file: giant.file })).toBeNull();
    expect(composeRead(ctx, { file: giant.file, offset: 12, limit: 2 })).toBeNull();
    expect(composeGrep(ctx, [{ file: giant.file, line: 12 }])).toBeNull();
    expect(composeGrep(ctx, [{ file: giant.file, line: null }])).toBeNull();
  });

  it("deduplicates knowledge and graph in the same push without spending dropped keys", () => {
    const a = node("A"), b = node("B", { start: 40, end: 50 });
    const ctx = context([a, b], [fact("mx_a", a)]);
    const knowledge = composeGrep(ctx, [{ file: a.file, line: 12 }])!;
    const graph = composeGraphSearch(ctx, [{ file: a.file, line: 12 }, { file: b.file, line: 42 }], `${a.name}|${b.name}`)!;
    const out = afterKnowledge(knowledge, graph)!;
    expect(out.graphNodes).toEqual([b.id]);
    expect(out.text.match(/#calculateA/g)).toHaveLength(1);
    expect(afterKnowledge(knowledge, graph, knowledge.text.length)).toBe(knowledge);
    expect(knowledge.remember).not.toContain(`graph:${b.id}`);
  });

  it("scopes names to hit files and excludes giant and callback primary spans", () => {
    const a = node("A"), collision = node("other", { name: a.name, file: "elsewhere.ts" });
    const giant = node("giant", { start: 50, end: 500 });
    const callback = node("callback", { name: "<callback:calculateA>", start: 600, end: 610 });
    const ctx = context([a, collision, giant, callback]);
    const out = composeGraphSearch(ctx, [{ file: a.file, line: 12 }, { file: a.file, line: 60 }, { file: a.file, line: 605 }], a.name)!;
    expect(out.graphNodes).toEqual([a.id]);
    expect(out.text).not.toContain("elsewhere");
    expect(out.text).not.toContain("callback");
  });

  it("summarizes more than three scoped definitions and deduplicates that summary", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(String(i), { name: "get_connection", file: `src/${i % 4}.ts` }));
    const ctx = context(nodes);
    const hits = nodes.map(n => ({ file: n.file, line: 12 }));
    const out = composeGraphSearch(ctx, hits, "get_connection")!;
    expect(out.text).toContain("6 definitions: src/0.ts, src/1.ts, src/2.ts, src/3.ts");
    expect(composeGraphSearch({ ...ctx, shown: new Set(out.remember) }, hits, "get_connection")).toBeNull();
  });

  it("adds at most one unvisited callee on a trace search and never a caller list", () => {
    const a = node("Flow"), b = node("B", { start: 40, end: 50 }), c = node("C", { start: 60, end: 70 });
    const ctx = context([a, b, c]);
    ctx.reader = { ...ctx.reader!, callees: () => [b, c] };
    const out = composeGraphSearch(ctx, [{ file: a.file, line: 12 }], a.name)!;
    expect(out.graphNodes).toEqual([a.id, b.id]);
    expect(out.text).toContain("next location (read body)");
    expect(out.text).not.toContain("callers");
    const next = composeGraphSearch({ ...ctx, shown: new Set([`graph:${b.id}`]) }, [{ file: a.file, line: 12 }], a.name)!;
    expect(next.graphNodes).toEqual([a.id, c.id]);
  });

  it("defaults impact off, with an explicit ablation switch", () => {
    const a = node("A"), b = node("B", { file: "src/use.ts" });
    const ctx = context([a, b]); ctx.reader = { ...ctx.reader!, callers: () => [b, node("cb", { name: "<callback:x>" }), node("test", { file: "tests/x.ts" })] };
    const diffs = new Map([[a.file, { ranges: [[12, 12] as [number, number]], signature: "edit" }]]);
    expect(composeGraphEdit(ctx, diffs)).toBeNull();
    vi.stubEnv("MEX_HOOK_GRAPH_IMPACT", "1");
    expect(composeGraphEdit(ctx, diffs)!.graphNodes).toEqual([a.id, b.id]);
  });

  it("requires resolved hunk overlap and narrows touch to citations within the recorded span", () => {
    const a = node("A"), e = fact("mx_a", a, { body: "This claim cites src/core.ts:12-14." });
    const diffs = (line: number) => new Map([[a.file, { ranges: [[line, line] as [number, number]], signature: "edit" }]]);
    expect(findTouched([e], [a.file], diffs(12), {})).toEqual([]);
    expect(findTouched([e], [a.file], diffs(20), { [e.id]: [a] })).toEqual([]);
    expect(findTouched([e], [a.file], diffs(12), { [e.id]: [a] })).toHaveLength(1);
    expect(findTouched([e], [a.file], diffs(31), { [e.id]: [a] })).toEqual([]);
  });

  it("keeps conservative flags quiet, and only points precisely touched claims at their body", () => {
    const a = node("A"), e = fact("mx_a", a);
    const ctx = context([a], [e]);
    const diffs = new Map([[a.file, { ranges: [[12, 12] as [number, number]], signature: "edit" }]]);
    expect(composeEdit(ctx, { diffs })!.text).toBe("");
    e.body = "The claim cites src/core.ts:12-14.";
    mkdirSync(join(ctx.projectRoot, ".mex/context"), { recursive: true });
    writeFileSync(join(ctx.projectRoot, ".mex/context/claims.md"), "## Claim\n\n<!-- metadata -->\n\nThe body.\n");
    expect(firstBodyLine(ctx, e)).toBe(5);
    const out = composeEdit({ ...ctx, shown: new Set([e.id]) }, { diffs })!;
    expect(out.text).toContain(".mex/context/claims.md:5");
    expect(out.text).not.toContain(e.body);
    expect(out.text).toContain("no action if still true");
    expect(composeEdit({ ...ctx, shown: new Set(out.remember) }, { diffs })).toBeNull();
  });

  it("adds bounded see-also pointers by shared grounding or explicit relationship", () => {
    const a = node("A"), b = node("B");
    const e = fact("mx_a", a, { line: 7 });
    const shared = fact("mx_shared", a), related = fact("mx_related", b);
    const ctx = context([a, b], [e, related, shared]);
    mkdirSync(join(ctx.projectRoot, ".mex/context"), { recursive: true });
    writeFileSync(join(ctx.projectRoot, ".mex/context/claims.md"), "<!-- mex:entity\nid: mx_a\nrelations:\n - target: mx_related\n-->\n\n## Claim\nThe body.\n");
    expect(seeAlso(ctx, [e])).toEqual(["see also: Claim mx_related \u00b7 mx_related"]);
    expect(seeAlso({ ...ctx, shown: new Set([related.id]) }, [e])).toEqual(["see also: Claim mx_shared \u00b7 mx_shared"]);
    expect(seeAlso({ ...ctx, shown: new Set([related.id, shared.id]) }, [e])).toEqual([]);
  });

  it("connects an exception claim to a response claim through a uniquely grounded enclosing symbol", () => {
    const throwing = node("Throw", { file: "src/validate.ts" });
    const response = node("Response", { file: "src/error.ts", start: 20, end: 25 });
    const error = node("Error", { name: "RequestError", file: response.file, start: 1, end: 40, kind: "class" });
    const a = fact("mx_throw", throwing, { body: "Throws `RequestError(400)` for malformed input." });
    const b = fact("mx_response", response, { body: "`RequestError` responses use the stored response." });
    const ctx = context([throwing, response, error], [a, b]);
    expect(seeAlso(ctx, [a])[0]).toContain(b.id);
    ctx.reader = { ...ctx.reader!, exactName: () => [error, { ...error, id: "collision", file: "other.ts" }] };
    expect(seeAlso(ctx, [a])).toEqual([]);
  });
});
