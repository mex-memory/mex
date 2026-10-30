import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../engine-impl.js";
import { createRepositoryGraphPort } from "../application-adapter.js";
import { loadFreshGraphReadSession } from "../read-session.js";
import { GRAPH_CORPUS_LIMITS } from "../corpus-policy.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-scoped-grounding-")); roots.push(root);
  writeFileSync(join(root, "linked.py"), "def value():\n    return 1\n");
  writeFileSync(join(root, "other.py"), "def other():\n    return 2\n");
  const fixed = new Date(1_700_000_000_000);
  utimesSync(join(root, "linked.py"), fixed, fixed);
  const engine = createGraphEngine({ rootDir: root });
  let id: string;
  try { await engine.build(); id = engine.searchNodes("value").find(node => node.kind === "function")!.id; }
  finally { engine.close(); }
  return { root, id, port: createRepositoryGraphPort(root) };
}

describe("apply-scoped grounding freshness", () => {
  it("keeps the source-file ceiling on explicitly scoped proofs", async () => {
    const { root } = await fixture();
    const loaded = await loadFreshGraphReadSession(root, {
      sourceScope: new Set(Array.from({ length: GRAPH_CORPUS_LIMITS.maxSourceFiles + 1 }, (_, index) => `file-${index}.py`)),
    });
    expect(loaded.session).toBeNull();
    expect(loaded.graphStatus.diagnostics.some(diagnostic => diagnostic.code === "GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED")).toBe(true);
  });

  it("ignores unrelated source edits while full readers refuse them", async () => {
    const { root, id, port } = await fixture();
    writeFileSync(join(root, "other.py"), "def other():\n    return 3\n");
    const scope = new Set<string>();
    let escaped: ((path: string) => void) | undefined;
    expect(await port.withFreshGroundingSnapshot(graph => {
      escaped = graph.verifySource;
      return graph.getNode(id)?.id;
    }, { sourceScope: scope })).toBe(id);
    expect([...scope]).toEqual(["linked.py"]);
    expect(() => escaped!("linked.py")).toThrow("no longer active");
    await expect(port.withFreshGroundingSnapshot(graph => graph.getNode(id))).rejects.toBeDefined();
  });

  it.each(["edit", "delete", "rename"])("refuses a linked source %s, including restored mtime", async kind => {
    const { root, id, port } = await fixture();
    const path = join(root, "linked.py"); const before = statSync(path);
    if (kind === "edit") {
      writeFileSync(path, "def value():\n    return 9\n"); utimesSync(path, before.atime, before.mtime);
      expect(statSync(path).size).toBe(before.size);
      expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    } else if (kind === "delete") rmSync(path);
    else renameSync(path, join(root, "renamed.py"));
    await expect(port.withFreshGroundingSnapshot(graph => graph.getNode(id), { sourceScope: new Set() })).rejects.toBeDefined();
  });

  it("refuses unindexed named files and changed configuration", async () => {
    const { root, port } = await fixture();
    writeFileSync(join(root, "new.py"), "def new():\n    pass\n");
    await expect(port.withFreshGroundingSnapshot(graph => graph.verifySource!("new.py"), { sourceScope: new Set() })).rejects.toBeDefined();
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    await expect(port.withFreshGroundingSnapshot(() => undefined, { sourceScope: new Set() })).rejects.toBeDefined();
  });

  it("preserves the stale refusal through direct symbol projection", async () => {
    const { root, id, port } = await fixture();
    writeFileSync(join(root, "linked.py"), "def value():\n    return 9\n");
    await expect(port.withFreshGroundingSnapshot(graph => graph.getSymbols([id]), { sourceScope: new Set() }))
      .rejects.toMatchObject({ problem: { code: "INDEX_STALE" } });
  });

  it("catches source changes and database replacement at the final boundary", async () => {
    const { root, id, port } = await fixture();
    await expect(port.withFreshGroundingSnapshot(graph => {
      graph.getNode(id);
      writeFileSync(join(root, "linked.py"), "def value():\n    return 9\n");
    }, { sourceScope: new Set() })).rejects.toBeDefined();
    writeFileSync(join(root, "linked.py"), "def value():\n    return 1\n");
    const db = join(root, ".mex", "graph.db");
    const bytes = readFileSync(db);
    await expect(port.withFreshGroundingSnapshot(graph => {
      graph.getNode(id);
      renameSync(db, db + ".old"); writeFileSync(db, bytes);
    }, { sourceScope: new Set() })).rejects.toBeDefined();
  });

  it("reads only the selected bytes in each scoped status proof", async () => {
    const { root } = await fixture();
    const read: string[] = [];
    const { inspectGraphStatusWithFreshObservation } = await import("../status.js");
    const loaded = await loadFreshGraphReadSession(root, {
      sourceScope: new Set(["linked.py"]),
      inspectObservation: options => inspectGraphStatusWithFreshObservation({ ...options,
        internal: { afterSourceRead: path => { read.push(path); } },
      }),
    });
    try {
      expect(loaded.session).not.toBeNull();
      expect((await loaded.session!.revalidateFreshness()).valid).toBe(true);
      expect(read.length).toBeGreaterThanOrEqual(3);
      expect(new Set(read)).toEqual(new Set(["linked.py"]));
    } finally { loaded.session?.close(); }
  });

  it("rejects an actual graph rebuild during scoped work", async () => {
    const { root, id, port } = await fixture();
    await expect(port.withFreshGroundingSnapshot(async graph => {
      graph.getNode(id);
      const engine = createGraphEngine({ rootDir: root });
      try { await engine.build(); } finally { engine.close(); }
    }, { sourceScope: new Set() })).rejects.toBeDefined();
  });
});
