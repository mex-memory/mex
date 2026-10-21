import { afterEach, describe, expect, it, vi } from "vitest";
import { openGraphReader } from "../../graph-reader.js";
import { buildGraph, cleanupProjects, createProject } from "../../__tests__/fixture.js";
import { afterKnowledge, composeGraphEdit, composeGraphPrompt, composeGraphSearch, GRAPH_CAP, GRAPH_MIN_CLASS_LINES, promptDefinition } from "../graph.js";
import { bashSearchPattern } from "../run.js";
import type { EventContext } from "../events.js";

afterEach(() => { cleanupProjects(); vi.unstubAllEnvs(); });
async function fixture() {
  const fx = createProject();
  fx.writeSource("src/core.ts", "export function calculateInvoice() {\n return 1;\n}\n");
  fx.writeSource("src/use.ts", 'import { calculateInvoice } from "./core.js";\nexport function sendInvoice() {\n return calculateInvoice();\n}\n');
  fx.writeSource("aaa.test.ts", 'import { calculateInvoice } from "./src/core.js";\nexport function testInvoice() {\n return calculateInvoice();\n}\n');
  await buildGraph(fx);
  const { reader } = openGraphReader(fx.context.scaffoldRoot);
  const ctx = { ...fx.context, reader, shown: new Set<string>(), head: null, index: { entities: [] } } as unknown as EventContext;
  return { fx, reader: reader!, ctx };
}

describe("graph tier", () => {
  it("extracts the first shell search pattern", () => {
    expect(bashSearchPattern('rg -n -g "*.ts" "calculateInvoice" src')).toBe("calculateInvoice");
    expect(bashSearchPattern("git grep -n -e calculateInvoice")).toBe("calculateInvoice");
    expect(bashSearchPattern("rg return src; echo calculateInvoice")).toBe("return");
    expect(bashSearchPattern("rg calculateInvoice src | head")).toBe("calculateInvoice");
  });
  it("queries exact names, ranges, counts and both edge directions; ranks tests last before the limit", async () => {
    const { reader } = await fixture();
    try {
      const node = reader.exactName("calculateInvoice", 4)[0]!;
      expect(reader.exactName("calculate", 4)).toEqual([]);
      expect(reader.inRange("src/core.ts", 2, 2, 5).map(n => n.id)).toContain(node.id);
      expect(reader.inRange("src/core.ts", 4, 5, 5)).toEqual([]);
      expect(reader.callerCount(node.id)).toBe(2);
      expect(reader.callers(node.id, 1)[0]!.name).toBe("sendInvoice");
      expect(reader.callers(node.id, 5).at(-1)!.file).toBe("aaa.test.ts");
      expect(reader.callees(reader.exactName("sendInvoice", 1)[0]!.id, 1)[0]!.id).toBe(node.id);
      expect(reader.exactName("calculateInvoice", -1)).toEqual([]);
    } finally { reader.close(); }
  });

  it("requires a verified identifier, skips notifications, honours the switch and deduplicates every named node", async () => {
    const { reader, ctx } = await fixture();
    try {
      expect(composeGraphPrompt(ctx, "fix the invoice typo")).toBeNull();
      expect(composeGraphPrompt(ctx, "unknownIdentifier")).toBeNull();
      expect(composeGraphPrompt(ctx, "<task-notification>calculateInvoice")).toBeNull();
      const note = composeGraphPrompt(ctx, "fix calculateInvoice")!;
      expect(note.text).toContain("src/core.ts:1-3");
      expect(note.text.length).toBeLessThanOrEqual(GRAPH_CAP);
      expect(composeGraphPrompt({ ...ctx, shown: new Set(note.remember) }, "calculateInvoice")).toBeNull();
      vi.stubEnv("MEX_HOOK_GRAPH", "0");
      expect(composeGraphPrompt(ctx, "calculateInvoice")).toBeNull();
      expect(composeGraphSearch(ctx, [{ file: "src/use.ts", line: 3 }], "calculateInvoice")).toBeNull();
      expect(composeGraphEdit(ctx, new Map([["src/core.ts", { ranges: [[2, 2]], signature: "x" }]]))).toBeNull();
    } finally { reader.close(); }
  });

  it("searches uses back to definitions and production callers; rejects broad and generic searches", async () => {
    const { reader, ctx } = await fixture();
    try {
      const hits = [{ file: "src/use.ts", line: 3 }];
      const note = composeGraphSearch(ctx, hits, "calculateInvoice")!;
      expect(note.text).toContain("#calculateInvoice src/core.ts:1-3");
      expect(note.text).toContain("#sendInvoice src/use.ts:2-4");
      expect(note.text).not.toContain("aaa.test");
      expect(composeGraphSearch({ ...ctx, shown: new Set(note.remember) }, hits, "calculateInvoice")).toBeNull();
      expect(composeGraphSearch(ctx, hits, "return")).toBeNull();
      expect(composeGraphSearch(ctx, Array(61).fill(hits[0]), "calculateInvoice")).toBeNull();
      expect(composeGraphSearch(ctx, Array.from({ length: 6 }, (_, i) => ({ file: `src/${i}.ts`, line: 1 })), "calculateInvoice")).toBeNull();
    } finally { reader.close(); }
  });

  it("names a class only for a prompt longer than one window, and never a marker class", async () => {
    const fx = createProject();
    fx.writeSource("src/store.ts", [
      "export class InvoiceStore {",
      "  private items: number[] = [];",
      "  add(n: number) {",
      "    this.items.push(n);",
      "  }",
      "}",
      "export class InvoiceError extends Error {",
      "  code = 1;",
      "}",
      "",
    ].join("\n"));
    await buildGraph(fx);
    const { reader } = openGraphReader(fx.context.scaffoldRoot);
    const ctx = { ...fx.context, reader, shown: new Set<string>(), head: null, index: { entities: [] } } as unknown as EventContext;
    try {
      expect(composeGraphPrompt(ctx, "Why does InvoiceStore throw InvoiceError?")).toBeNull();
      const filler = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
      const note = composeGraphPrompt(ctx, `Bug report: InvoiceStore throws InvoiceError when an item is added twice. ${filler}`)!;
      expect(note.text).toContain("#InvoiceStore src/store.ts:1-6");
      expect(note.text).not.toContain("InvoiceError");
      const cls = { id: "c", name: "C", file: "a.ts", start: 10, end: 14, bodyHash: "", kind: "class" };
      expect(promptDefinition(cls, true)).toBe(true);
      expect(promptDefinition(cls, false)).toBe(false);
      expect(promptDefinition({ ...cls, end: 10 + GRAPH_MIN_CLASS_LINES - 2 }, true)).toBe(false);
      expect(promptDefinition({ ...cls, kind: "method" }, false)).toBe(true);
      expect(promptDefinition({ ...cls, kind: "interface" }, true)).toBe(false);
    } finally { reader?.close(); }
  });

  it("edit impact is bounded, gives other production callers, and knowledge retains priority", async () => {
    const { reader, ctx } = await fixture();
    try {
      const note = composeGraphEdit(ctx, new Map([["src/core.ts", { ranges: [[2, 2]], signature: "x" }]]))!;
      expect(note.text).toContain("check callers: #sendInvoice");
      expect(note.text).not.toContain("aaa.test");
      const knowledge = { text: "knowledge", ids: ["fact"], remember: ["fact"] };
      expect(afterKnowledge(knowledge, note)!.text.startsWith("knowledge\n\nMEX graph")).toBe(true);
      expect(afterKnowledge(knowledge, note, 20)).toBe(knowledge);
      const node = reader.exactName("calculateInvoice", 1)[0]!;
      const oversized = { ...reader, exactName: () => [{ ...node, name: "x".repeat(1500) }] };
      expect(composeGraphPrompt({ ...ctx, reader: oversized }, "calculateInvoice")).toBeNull();
      expect(composeGraphPrompt({ ...ctx, reader: null }, "calculateInvoice")).toBeNull();
    } finally { reader.close(); }
  });
});
