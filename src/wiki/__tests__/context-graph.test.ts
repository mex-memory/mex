import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryWikiPort, type RepositoryWikiGroundingSnapshot } from "../application-adapter.js";
import { withWikiContractReadSessionAsync } from "../query/contract-session.js";
import { MexPortError } from "../../team/contracts/shared.js";

const roots: string[] = [];
const id = (index: number) => `mx_${String(index).padStart(26, "0")}`;
const NODE = "function:1111111111111111";
const FINGERPRINT = "mh:4:11111111";
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(count = 32, dense = false, grounded = false) {
  const root = mkdtempSync(join(tmpdir(), "mex-context-graph-"));
  roots.push(root);
  const scaffold = join(root, ".mex");
  mkdirSync(join(scaffold, "context"), { recursive: true });
  const path = join(scaffold, "context", "units.md");
  const metadata = (index: number) => {
    const targets = dense ? Array.from({ length: count }, (_, i) => i).filter((i) => i !== index)
      : index === 0 ? [1] : [];
    return `id: ${id(index)}\ntype: ${index === 0 ? "architecture" : "component"}\nstatus: ${index === count - 1 ? "archived" : "promoted"}\nrevision: 1\n`
      + (targets.length ? `relations:\n${targets.map((target) => `  - type: related_to\n    target: ${id(target)}\n    note: Recorded connection ${index} to ${target}\n`).join("")}` : "")
      + (grounded && index === 0 ? `grounds_to:\n  - node: ${NODE}\n    fingerprint: ${FINGERPRINT}\n` : "");
  };
  writeFileSync(path, `---\nmex:\n${metadata(0).split("\n").filter(Boolean).map((line) => `  ${line}\n`).join("")}---\n# Unit 000\n\nA document entity.\n\n`
    + Array.from({ length: count - 1 }, (_, i) => i + 1).map((index) => (
      `<!-- mex:entity\n${metadata(index)}-->\n## Unit ${String(index).padStart(3, "0")}\n\nA separately addressable section.\n\n`
    )).join(""));
  return { root, scaffold, path };
}

function snapshot() {
  return {
    revision: "b".repeat(64),
    getNode: (node: string) => node === NODE ? { id: NODE, bodyHash: "c".repeat(64), filePath: "src/queue.ts", startLine: 1, endLine: 4 } : null,
    getFingerprint: (node: string) => node === NODE ? FINGERPRINT : null,
    reconcile: () => null, getBaselineSource: () => null,
    getSymbols: vi.fn((nodes: readonly string[]) => nodes.includes(NODE) ? [{
      ref: { kind: "symbol" as const, symbolId: NODE }, symbolKind: "function", name: "queue", qualifiedName: "queue", language: "typescript",
      path: "src/queue.ts", startLine: 1, endLine: 4, signature: "queue(): void",
    }] : []),
  } satisfies RepositoryWikiGroundingSnapshot;
}

describe("Context graph repository reads", () => {
  it("includes every document and disconnected section, including archived units, and excludes Team kinds", async () => {
    const target = fixture();
    mkdirSync(join(target.scaffold, "workstreams"));
    writeFileSync(join(target.scaffold, "workstreams", "team.md"), `<!-- mex:entity\nid: ws_01ARZ3NDEKTSV4RRFFQ69G5FAV\ntype: workstream\nstatus: in_flight\nrevision: 1\n-->\n## Team work\n\nA separate workbench.\n`);
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const index = join(target.scaffold, "wiki.db");
    const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs, entries: readdirSync(target.scaffold) };
    const graph = await port.graphOverview();
    expect(graph.nodes).toHaveLength(32);
    expect(graph.nodes.map((node) => node.ref.id)).toEqual(Array.from({ length: 32 }, (_, index) => id(index)));
    expect(graph.nodes.at(-1)?.lifecycleState).toBe("archived");
    expect(graph.relations).toMatchObject([{ type: "related_to", source: { id: id(0) }, target: { id: id(1) }, note: "Recorded connection 0 to 1" }]);
    expect(graph.coverage).toEqual({ nodeLimit: 100, relationLimit: 500, nodesTruncated: false, relationsTruncated: false });
    expect(graph.indexedRevision).toBe((await port.readKnowledgeWorkspace({ entityId: id(0) })).indexedRevision);
    expect({ bytes: readFileSync(index), mtime: statSync(index).mtimeMs, entries: readdirSync(target.scaffold) }).toEqual(before);
  });

  it("caps the node set and relationships independently without dangling displayed endpoints", async () => {
    const large = fixture(101);
    const largePort = createRepositoryWikiPort(large.root);
    await largePort.rebuildIndex();
    const graph = await largePort.graphOverview();
    expect(graph.nodes).toHaveLength(100);
    expect(graph.coverage.nodesTruncated).toBe(true);
    const dense = fixture(26, true);
    const densePort = createRepositoryWikiPort(dense.root);
    await densePort.rebuildIndex();
    const denseGraph = await densePort.graphOverview();
    expect(denseGraph.relations).toHaveLength(500);
    expect(denseGraph.coverage).toMatchObject({ nodesTruncated: false, relationsTruncated: true });
    const ids = new Set(denseGraph.nodes.map((node) => node.ref.id));
    expect(denseGraph.relations.every((edge) => ids.has(edge.source.id) && ids.has(edge.target.id))).toBe(true);
  });

  it("rejects missing, stale, and mid-read changed Wiki snapshots without repair", async () => {
    const target = fixture(3);
    const port = createRepositoryWikiPort(target.root);
    await expect(port.graphOverview()).rejects.toMatchObject({ problem: { code: "INDEX_MISSING" } });
    await port.rebuildIndex();
    const index = join(target.scaffold, "wiki.db");
    const before = readFileSync(index);
    const racing = createRepositoryWikiPort(target.root, { __internal: {
      readAsync: (options, callback) => withWikiContractReadSessionAsync(options, async (session) => {
        const result = await callback(session);
        writeFileSync(target.path, readFileSync(target.path, "utf8") + "\nChanged during read.\n");
        return result;
      }),
    } });
    await expect(racing.graphOverview()).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    await expect(port.graphOverview()).rejects.toMatchObject({ problem: { code: "INDEX_STALE" } });
    await expect(port.readGroundedCode(id(0))).rejects.toMatchObject({ problem: { code: "INDEX_STALE" } });
    expect(readFileSync(index)).toEqual(before);
  });

  it("keeps an authored parent outside the first page visible without raising the node cap", async () => {
    const target = fixture(101);
    const text = readFileSync(target.path, "utf8").replace(
      `    target: ${id(1)}`, `    target: ${id(100)}`
    ).replace("type: related_to", "type: refines");
    writeFileSync(target.path, text);
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const graph = await port.graphOverview();
    expect(graph.nodes).toHaveLength(100);
    expect(graph.nodes.some(node => node.ref.id === id(100))).toBe(true);
    expect(graph.relations).toMatchObject([{ type: "refines", source: { id: id(0) }, target: { id: id(100) } }]);
    expect(graph.coverage.nodesTruncated).toBe(true);
  });

  it("reads compact symbols and grounding health through one shared Graph observation", async () => {
    const target = fixture(3, false, true);
    await createRepositoryWikiPort(target.root).rebuildIndex();
    const graph = snapshot();
    let calls = 0;
    const port = createRepositoryWikiPort(target.root, { groundingBridge: {
      async withFreshGroundingSnapshot(callback) { calls += 1; return callback(graph); },
    } });
    const result = await port.readGroundedCode(id(0));
    expect(calls).toBe(1);
    expect(graph.getSymbols).toHaveBeenCalledExactlyOnceWith([NODE]);
    expect(result).toMatchObject({ entityId: id(0), graphRevision: graph.revision, truncated: false,
      groundings: [{ requestedNode: NODE, resolvedNode: NODE, health: "fresh", symbol: { ref: { symbolId: NODE }, name: "queue" } }],
    });
    expect(JSON.stringify(result)).not.toContain("fingerprint");
    expect(JSON.stringify(result)).not.toContain("bodyHash");
    expect((await port.readGroundedCode(id(1))).groundings).toEqual([]);
  });

  it("discards Graph results after final freshness failure and keeps canonical groundings unverified", async () => {
    const target = fixture(3, false, true);
    await createRepositoryWikiPort(target.root).rebuildIndex();
    const port = createRepositoryWikiPort(target.root, { groundingBridge: {
      async withFreshGroundingSnapshot(callback) {
        await callback(snapshot());
        throw new MexPortError({ code: "REVISION_CONFLICT", status: 409, title: "Graph changed", detail: "Final Graph observation changed." });
      },
    } });
    await expect(port.readGroundedCode(id(0))).resolves.toMatchObject({
      graphRevision: null, groundings: [{ requestedNode: NODE, resolvedNode: null, health: "unverified", symbol: null }],
    });
    await expect(port.readGroundedCode(id(99))).rejects.toMatchObject({ problem: { code: "NOT_FOUND" } });
  });

  it("bounds canonical grounding entries even when code is unavailable", async () => {
    const target = fixture(3);
    const source = readFileSync(target.path, "utf8").replace("  revision: 1\n", "  revision: 1\n  grounds_to:\n"
      + Array.from({ length: 51 }, (_, index) => `    - node: function:${String(index).padStart(16, "0")}\n      fingerprint: ${FINGERPRINT}\n`).join(""));
    writeFileSync(target.path, source);
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const result = await port.readGroundedCode(id(0));
    expect(result.groundings).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.graphRevision).toBeNull();
    expect(result.groundings.every((grounding) => grounding.health === "unverified" && grounding.symbol === null)).toBe(true);
  });
});
