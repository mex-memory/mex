import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureFactVectors } from "../dense.js";
import {
  ensureContextIndex,
  indexPathOf,
  loadContextIndex,
  saveContextIndex,
} from "../index-store.js";
import { CONTEXT_INDEX_SCHEMA_VERSION } from "../types.js";
import {
  buildGraph,
  cleanupProjects,
  createProject,
  entityBlock,
  fakeEmbedder,
  graphSymbol,
  STANDARD_FACTS,
  writeEntities,
  type Fixture,
} from "./fixture.js";

let fx: Fixture;
let ids: string[];

function markdownLine(fixture: Fixture, relative: string, heading: string): number {
  const lines = readFileSync(join(fixture.context.scaffoldRoot, relative), "utf8").split(/\r?\n/);
  return lines.findIndex((line) => line.startsWith(heading)) + 1;
}

beforeEach(() => {
  fx = createProject();
  ids = writeEntities(fx, "context/notes.md", [
    ...STANDARD_FACTS,
    { type: "convention", title: "Errors are thrown as typed results", body: "Services return a typed result object instead of throwing, and callers branch on its kind field." },
    { type: "task", title: "Migrate the old billing tables", body: "A task is not knowledge a prompt can be answered from, so the index leaves it out entirely." },
  ]);
});
afterEach(cleanupProjects);

describe("context index build", () => {
  it("collects the typed entities the Wiki parser sees, with ids, locations and aliases", async () => {
    const aliased = entityBlock({
      title: "Tenant limits are enforced at the edge",
      body: "Rate limits for a tenant are enforced by the edge proxy before a request reaches any service.",
      aliases: ["why do I get 429 errors", "tenant throttling"],
    });
    fx.writeScaffoldFile("context/limits.md", `# Limits\n\n${aliased.text}`);

    const ensured = await ensureContextIndex(fx.context);
    expect(ensured.rebuilt).toBe(true);
    const { index } = ensured;
    expect(index.schemaVersion).toBe(CONTEXT_INDEX_SCHEMA_VERSION);
    const types = new Set(index.entities.map((e) => e.type));
    expect(types).toEqual(new Set(["fact", "convention"]));
    expect(index.entities.map((e) => e.id)).not.toContain(ids[ids.length - 1]);

    const limits = index.entities.find((e) => e.id === aliased.id)!;
    expect(limits).toMatchObject({
      title: "Tenant limits are enforced at the edge",
      aliases: ["why do I get 429 errors", "tenant throttling"],
      file: "context/limits.md",
      line: markdownLine(fx, "context/limits.md", "### Tenant limits"),
      level: 3,
    });
    expect(limits.body).toContain("edge proxy");
  });

  it("records graph symbols and bodies' hashes for grounded entities", async () => {
    fx.writeSource("src/billing.ts", "export function calculateOrderTotal(items: number[]): number {\n  return items.length;\n}\n");
    await buildGraph(fx);
    const symbol = graphSymbol(fx, "calculateOrderTotal");
    const [id] = writeEntities(fx, "context/billing.md", [
      {
        title: "Order totals count the items",
        body: "The order total is the number of items in the basket and nothing else at all.",
        groundings: [{ node: symbol.id, file: symbol.file, bodyHash: symbol.bodyHash }],
      },
    ]);
    const { index } = await ensureContextIndex(fx.context);
    const entity = index.entities.find((e) => e.id === id)!;
    expect(entity.groundings).toEqual([{ node: symbol.id, file: symbol.file, bodyHash: symbol.bodyHash }]);
    expect(entity.symbols).toEqual([
      { node: symbol.id, name: "calculateOrderTotal", file: "src/billing.ts", start: 1, end: 3, bodyHash: symbol.bodyHash },
    ]);
    expect(entity.code).toEqual(["src/billing.ts"]);
    expect(index.inputs.graph.identity).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes .mex/local/context-index.json with its input identities", async () => {
    await ensureContextIndex(fx.context);
    const path = indexPathOf(fx.context.localDir);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.inputs.wiki.files.map((f: { path: string }) => f.path)).toEqual(["ROUTER.md", "context/notes.md"]);
    expect(onDisk.inputs.wiki.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk.inputs.graph.identity).toBeNull();
    // The Markdown under .mex/local is checkout-local state, never a source.
    fx.writeScaffoldFile("local/draft.md", `# Draft\n\n${entityBlock({ title: "Local only", body: "This entity lives in local state and must never be indexed." }).text}`);
    const again = await ensureContextIndex(fx.context, "force");
    expect(again.index.entities.map((e) => e.title)).not.toContain("Local only");
  });
});

describe("invalidation", () => {
  it("reuses a current index without rebuilding it", async () => {
    const first = await ensureContextIndex(fx.context);
    const second = await ensureContextIndex(fx.context);
    expect(first.rebuilt).toBe(true);
    expect(second.rebuilt).toBe(false);
    expect(second.index.builtAt).toBe(first.index.builtAt);
  });

  it("rebuilds when a Markdown file's bytes change", async () => {
    const first = await ensureContextIndex(fx.context);
    const text = readFileSync(join(fx.context.scaffoldRoot, "context/notes.md"), "utf8");
    fx.writeScaffoldFile("context/notes.md", text.replace("Image thumbnails", "Picture thumbnails"));
    const second = await ensureContextIndex(fx.context);
    expect(second.rebuilt).toBe(true);
    expect(second.index.inputs.wiki.digest).not.toBe(first.index.inputs.wiki.digest);
    expect(second.index.entities.map((e) => e.title)).toContain("Picture thumbnails are generated lazily on first request");
  });

  it("rebuilds when a Markdown file appears or disappears", async () => {
    await ensureContextIndex(fx.context);
    const added = entityBlock({ title: "Queues drain in arrival order", body: "Each queue drains strictly in arrival order and never reorders by priority." });
    fx.writeScaffoldFile("context/queues.md", `# Queues\n\n${added.text}`);
    const second = await ensureContextIndex(fx.context);
    expect(second.rebuilt).toBe(true);
    expect(second.index.entities.map((e) => e.id)).toContain(added.id);
  });

  it("keeps the index when a file is rewritten with identical bytes, and refreshes its signature", async () => {
    const first = await ensureContextIndex(fx.context);
    const path = join(fx.context.scaffoldRoot, "context/notes.md");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text);
    const future = new Date(Date.now() + 60_000);
    utimesSync(path, future, future);
    const second = await ensureContextIndex(fx.context);
    expect(second.rebuilt).toBe(false);
    expect(second.index.inputs.wiki.digest).toBe(first.index.inputs.wiki.digest);
    const third = await ensureContextIndex(fx.context);
    expect(third.rebuilt).toBe(false);
    const notes = loadContextIndex(fx.context.localDir).index!.inputs.wiki.files.find((f) => f.path === "context/notes.md")!;
    expect(notes.stat).toBe(third.index.inputs.wiki.files.find((f) => f.path === "context/notes.md")!.stat);
  });

  it("rebuilds when the graph snapshot changes", async () => {
    fx.writeSource("src/a.ts", "export function alpha(): number {\n  return 1;\n}\n");
    await buildGraph(fx);
    const first = await ensureContextIndex(fx.context);
    expect(first.index.inputs.graph.identity).not.toBeNull();
    expect((await ensureContextIndex(fx.context)).rebuilt).toBe(false);

    fx.writeSource("src/a.ts", "export function alpha(): number {\n  return 2;\n}\n");
    await buildGraph(fx);
    const second = await ensureContextIndex(fx.context);
    expect(second.rebuilt).toBe(true);
    expect(second.index.inputs.graph.identity).not.toBe(first.index.inputs.graph.identity);
  });

  it("rebuilds when the alias overlay changes, and merges it with authored aliases", async () => {
    const first = await ensureContextIndex(fx.context);
    const target = first.index.entities[0]!;
    fx.writeScaffoldFile("local/context-aliases.json", JSON.stringify({ [target.id]: ["a symptom phrase"] }));
    const second = await ensureContextIndex(fx.context);
    expect(second.rebuilt).toBe(true);
    expect(second.index.entities.find((e) => e.id === target.id)!.aliases).toEqual(["a symptom phrase"]);
  });

  it("treats a corrupt or incompatible index file as missing and rebuilds it", async () => {
    await ensureContextIndex(fx.context);
    writeFileSync(indexPathOf(fx.context.localDir), "{ not json");
    expect(loadContextIndex(fx.context.localDir).state).toBe("unreadable");
    expect((await ensureContextIndex(fx.context)).rebuilt).toBe(true);
    writeFileSync(indexPathOf(fx.context.localDir), JSON.stringify({ schemaVersion: 999 }));
    expect(loadContextIndex(fx.context.localDir).state).toBe("incompatible");
    expect((await ensureContextIndex(fx.context)).rebuilt).toBe(true);
    expect(loadContextIndex(fx.context.localDir).state).toBe("ok");
  });

  it("carries fact vectors across a rebuild only where the text still matches", async () => {
    const embedder = fakeEmbedder();
    const first = await ensureContextIndex(fx.context);
    const facts = first.index.entities.filter((e) => e.type === "fact");
    await ensureFactVectors(first.index, facts, embedder);
    saveContextIndex(fx.context.localDir, first.index);
    expect(Object.keys(first.index.vectors[embedder.modelId]!)).toHaveLength(facts.length);

    const forced = await ensureContextIndex(fx.context, "force");
    expect(Object.keys(forced.index.vectors[embedder.modelId]!)).toHaveLength(facts.length);
    const refreshed = await ensureFactVectors(forced.index, forced.index.entities.filter((e) => e.type === "fact"), embedder);
    expect(refreshed.computed).toBe(0);
  });
});
