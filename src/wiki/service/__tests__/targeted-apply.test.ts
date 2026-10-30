import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGraphEngine } from "../../../graph/engine-impl.js";
import { createRepositoryGraphPort } from "../../../graph/application-adapter.js";
import { writeWithGraph, readWithGraph } from "../../cli/grounding.js";
import { locateEntity } from "../../operations/locate.js";
import { openWikiIndex } from "../../index/open.js";
import { dumpWikiIndex } from "../../index/dump.js";
import { wikiApplyOperation, wikiApplyOperationBatch, wikiRebuildIndex } from "../write.js";
import { runApply } from "../../cli/commands.js";
import type { GroundingGraph } from "../../grounding/adapter.js";
import { resolveGrounding } from "../../grounding/resolve.js";
import { createEntityTypeRegistry } from "../../model/entity.js";

const roots: string[] = [];
const ids = ["mx_01KR2E4K002H3ZYA9G0C4XV531", "mx_01KRMEXM00JAAVJPQVVRX8N56V"];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function inspect(root: string) {
  const opened = openWikiIndex(join(root, ".mex/wiki.db"));
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  try {
    return { dump: dumpWikiIndex(opened.index.db), rows: opened.index.db.prepare(
      "SELECT entity_key, ordinal, resolution FROM wiki_groundings ORDER BY entity_key, ordinal",
    ).all() as Array<{entity_key: string; ordinal: number; resolution: string | null}> };
  } finally { opened.index.close(); }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-targeted-apply-")); roots.push(root);
  const scaffoldRoot = join(root, ".mex"); mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
  for (const [index, name] of ["left", "right"].entries()) {
    writeFileSync(join(root, `${name}.py`), `def ${name}():\n    return ${index}\n`);
    const fixed = new Date(1_700_000_000_000); utimesSync(join(root, `${name}.py`), fixed, fixed);
  }
  async function refresh() {
    const engine = createGraphEngine({ rootDir: root });
    try { await engine.build(); } finally { engine.close(); }
  }
  await refresh();
  const port = createRepositoryGraphPort(root);
  await port.withFreshGroundingSnapshot(graph => {
    const engine = createGraphEngine({ rootDir: root });
    try {
      for (const [index, name] of ["left", "right"].entries()) {
        const node = engine.searchNodes(name).find(node => node.name === name)!;
        writeFileSync(join(scaffoldRoot, `context/${name}.md`), `---\nmex:\n  id: ${ids[index]}\n  type: fact\n  title: ${name}\n  status: promoted\n  revision: 1\n  grounds_to:\n    - node: ${node.id}\n      fingerprint: ${graph.getFingerprint(node.id)}\n      bodyHash: ${node.bodyHash}\n      file: ${name}.py\n---\n\n# ${name}\n\nInitial claim.\n`);
      }
    } finally { engine.close(); }
    wikiRebuildIndex({ scaffoldRoot, graph });
  });
  return { root, scaffoldRoot, port, refresh };
}

function operation(scaffoldRoot: string, index: number, step: number, choice = step) {
  const entity = locateEntity(ids[index]!, { scaffoldRoot })!.entity;
  return { opId: `targeted-${step}`, type: choice % 3 === 0 ? "set-property" : "update-entry", entityId: entity.id,
    baseRevision: entity.revision, baseContentHash: entity.location.entityContentHash,
    actor: { kind: "human", id: "fixture" }, timestamp: "2026-10-24T00:00:00.000Z",
    payload: choice % 3 === 0 ? { property: "status", value: choice % 2 === 0 ? "promoted" : "deprecated" } : { body: `Claim at step ${step}.` },
  };
}

describe("targeted apply index refresh", () => {
  it("scopes a CLI batch to the union of new named links, and preserves full stale refusals", async () => {
    const { root, scaffoldRoot, port } = await fixture();
    const batch = (step: number, both = false) => (both ? ["left", "right"] : ["left"]).map(name => ({
      opId: `batch-${step}-${name}`, type: "create-entry",
      actor: { kind: "human", id: "fixture" }, timestamp: "2026-10-24T00:00:00.000Z",
      payload: { file: `context/new-${name}.md`, insertAt: { at: "end-of-file" }, type: "fact",
        title: `${name} claim ${step}`, body: "A claim.", groundsTo: [{ file: `${name}.py`, symbol: name }] },
    }));
    const run = async (envelopes: unknown[], apply: boolean) => {
      const path = join(root, "batch.json"); writeFileSync(path, JSON.stringify(envelopes));
      const lines: string[] = [];
      await runApply({ scaffoldRoot, projectRoot: root, groundingBridge: port,
        write: line => { lines.push(line); }, setExitCode: () => undefined,
      }, path, { apply, json: true });
      return JSON.parse(lines.join("\n"));
    };
    const path = join(root, "right.py"); const before = statSync(path);
    writeFileSync(path, "def right():\n    return 9\n"); utimesSync(path, before.atime, before.mtime);
    expect((await run(batch(1), true)).data.applied).toBe(true);
    const unchanged = inspect(root).dump;
    for (const apply of [false, true]) {
      const request = batch(2, true);
      const full = await (apply ? writeWithGraph : readWithGraph)(port,
        graph => wikiApplyOperationBatch(request, { scaffoldRoot, graph, apply }));
      const scoped = await run(request, apply);
      expect(scoped.data.applied).toBe(false);
      expect(scoped.diagnostics).toEqual([...full.value.diagnostics.map(({ path: _path, ...entry }) => entry),
        expect.objectContaining({ code: "CODE_GRAPH_UNAVAILABLE" })]);
      expect(inspect(root).dump).toBe(unchanged);
    }
  });

  it("refreshes only batch files, proves their siblings and removed links, and matches a full rebuild", async () => {
    const { root, scaffoldRoot, port } = await fixture();
    const before = inspect(root).rows;
    const scope = new Set<string>();
    await port.withFreshGroundingSnapshot(graph => {
      const calls: string[] = [];
      const observed: GroundingGraph = { ...graph, getNode(id) { calls.push(id); return graph.getNode(id); } };
      const result = wikiApplyOperationBatch([operation(scaffoldRoot, 0, 101)], { scaffoldRoot, graph: observed, apply: true });
      expect(result.data.applied).toBe(true);
      expect(new Set(calls).size).toBe(1);
      const targeted = inspect(root);
      expect(targeted.rows[1]).toEqual(before[1]);
      expect([...scope]).toEqual(["left.py"]);
      wikiRebuildIndex({ scaffoldRoot, graph });
      expect(inspect(root).dump).toBe(targeted.dump);
    }, { sourceScope: scope });
    writeFileSync(join(root, "left.py"), "def left():\n    return 9\n");
    const entity = locateEntity(ids[0]!, { scaffoldRoot })!.entity;
    const request = { ...operation(scaffoldRoot, 0, 102), type: "set-grounding", payload: { groundsTo: [] } };
    const removed = await readWithGraph(port, graph => wikiApplyOperationBatch([request], { scaffoldRoot, graph }), { sourceScope: new Set() });
    expect(removed.unavailable).toBe("stale");
    expect(locateEntity(ids[0]!, { scaffoldRoot })!.entity.groundsTo).toEqual(entity.groundsTo);
  });

  it("includes existing links on registered entity types in the source preflight", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-targeted-custom-")); roots.push(root);
    mkdirSync(join(root, "context"));
    writeFileSync(join(root, "context/custom.md"), `---\nmex:\n  id: ${ids[0]}\n  type: project_fact\n  title: Custom fact\n  status: promoted\n  revision: 1\n  grounds_to:\n    - node: function:aaaaaaaa\n      fingerprint: mh:64:0a\n      file: linked.py\n---\n\n# Custom fact\n\nOriginal claim.\n`);
    const registry = createEntityTypeRegistry(["project_fact"]);
    const entity = locateEntity(ids[0]!, { scaffoldRoot: root, registry })!.entity;
    const graph: GroundingGraph = {
      getNode: () => null, getFingerprint: () => null, reconcile: () => ({ kind: "GONE" }), getBaselineSource: () => null,
      verifySource() { throw new Error("scoped source preflight"); },
    };
    expect(() => wikiApplyOperation({ opId: "custom-preflight", type: "update-entry", entityId: entity.id,
      baseRevision: entity.revision, baseContentHash: entity.location.entityContentHash,
      actor: { kind: "human", id: "fixture" }, timestamp: "2026-10-24T00:00:00.000Z", payload: { body: "Updated claim." },
    }, { scaffoldRoot: root, registry, graph })).toThrow("scoped source preflight");
  });

  it("resolves only reparsed groundings and keeps their graph identity and global diagnostics consistent", async () => {
    const { root, scaffoldRoot, port } = await fixture();
    const before = inspect(root).rows;
    const calls: string[] = [];
    await port.withFreshGroundingSnapshot(graph => {
      const observed: GroundingGraph = { ...graph, getNode(id) { calls.push(id); return graph.getNode(id); } };
      const result = wikiApplyOperation(operation(scaffoldRoot, 0, 1), { scaffoldRoot, graph: observed, apply: true });
      expect(result.data.applied).toBe(true);
      expect(new Set(calls).size).toBe(1);
      const after = inspect(root);
      expect(after.rows[1]).toEqual(before[1]);
      expect(JSON.parse(after.rows[0]!.resolution!).graphRevision).toBe(graph.revision);
      wikiRebuildIndex({ scaffoldRoot, graph });
      expect(inspect(root).dump).toBe(after.dump);
    }, { sourceScope: new Set() });
  });

  it.each([false, true])("proves sibling links before writing (batch: %s)", async batch => {
    const { root, scaffoldRoot, port } = await fixture();
    const grounding = locateEntity(ids[1]!, { scaffoldRoot })!.entity.groundsTo[0]!;
    appendFileSync(join(scaffoldRoot, "context/left.md"), `\n<!-- mex:entity\nid: mx_01KS6FPN00RT04JXY9QEG0JN19\ntype: fact\nstatus: promoted\nrevision: 1\ngrounds_to:\n  - node: ${grounding.node}\n    fingerprint: ${grounding.fingerprint}\n    bodyHash: ${grounding.bodyHash}\n    file: right.py\n-->\n## Sibling\n\nA linked sibling claim.\n`);
    await port.withFreshGroundingSnapshot(graph => wikiRebuildIndex({ scaffoldRoot, graph }));
    writeFileSync(join(root, "right.py"), "def right():\n    return 9\n");
    const scope = new Set<string>();
    const result = await writeWithGraph(port, graph => (batch ? wikiApplyOperationBatch : wikiApplyOperation)(batch ? [operation(scaffoldRoot, 0, 1)] : operation(scaffoldRoot, 0, 1),
      { scaffoldRoot, graph, apply: true }), { sourceScope: scope });
    expect(result.unavailable).toBe("stale");
    expect(scope.has("right.py")).toBe(true);
    expect(result.value.diagnostics.some(diagnostic => diagnostic.code === "INDEX_REFRESH_REQUIRED")).toBe(false);
  });

  it("keeps apply and check-only stale diagnostics aligned with full freshness, while unrelated edits succeed", async () => {
    const { root, scaffoldRoot, port } = await fixture();
    const request = operation(scaffoldRoot, 0, 1);
    const path = join(root, "left.py"); const before = statSync(path);
    writeFileSync(path, "def left():\n    return 9\n"); utimesSync(path, before.atime, before.mtime);
    for (const apply of [false, true]) {
      const work = (graph: GroundingGraph | null) => wikiApplyOperation(request, { scaffoldRoot, graph, ...(apply ? { apply: true } : {}) });
      const run = apply ? writeWithGraph : readWithGraph;
      const full = await readWithGraph(port, graph => wikiApplyOperation(request, { scaffoldRoot, graph }));
      const scoped = await run(port, work, { sourceScope: new Set() });
      expect(scoped.unavailable).toBe(full.unavailable);
      expect(scoped.unavailable).toBe("stale");
      expect(scoped.value.diagnostics).toEqual(full.value.diagnostics);
    }
    const entity = locateEntity(ids[0]!, { scaffoldRoot })!.entity;
    const added = { opId: "targeted-new-link", type: "create-entry",
      actor: { kind: "human", id: "fixture" }, timestamp: "2026-10-24T00:00:00.000Z",
      payload: { file: "context/new.md", insertAt: { at: "end-of-file" }, type: "fact", title: "New linked claim",
        body: "A claim.", groundsTo: entity.groundsTo },
    };
    for (const apply of [false, true]) {
      const work = (graph: GroundingGraph | null) => wikiApplyOperation(added, { scaffoldRoot, graph, ...(apply ? { apply: true } : {}) });
      const full = await (apply ? writeWithGraph : readWithGraph)(port, work);
      const scoped = await (apply ? writeWithGraph : readWithGraph)(port, work, { sourceScope: new Set() });
      expect(scoped.unavailable).toBe("stale");
      expect(scoped.value.data.applied).toBe(false);
      expect(scoped.value.diagnostics).toEqual(full.value.diagnostics);
    }
  });

  it("matches full touched verdicts through 48 seeded operations, source edits, and graph publications", async () => {
    const { root, scaffoldRoot, port, refresh } = await fixture();
    let seed = 0x12345678;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    let dirty = false;
    let sourceEdits = 0;
    let staleTouched = 0;
    let cleanTouchedDuringDrift = 0;
    for (let step = 1; step <= 48; step++) {
      const index = random() % 2;
      if (random() % 7 === 0) {
        writeFileSync(join(root, "right.py"), `def right():\n    return ${step * 1000 + random() % 997}\n`);
        dirty = true;
        sourceEdits++;
      }
      if (step % 8 === 0) {
        await refresh(); dirty = false;
        await port.withFreshGroundingSnapshot(graph => wikiRebuildIndex({ scaffoldRoot, graph }));
      }
      const request = operation(scaffoldRoot, index, step, random());
      const result = await writeWithGraph(port, graph => step % 2 === 0
        ? wikiApplyOperationBatch([request], { scaffoldRoot, graph, apply: true })
        : wikiApplyOperation(request, { scaffoldRoot, graph, apply: true }), { sourceScope: new Set() });
      expect(result.value.data.applied, JSON.stringify(result.value.diagnostics)).toBe(true);
      if (!dirty) {
        const targeted = inspect(root);
        await port.withFreshGroundingSnapshot(graph => wikiRebuildIndex({ scaffoldRoot, graph }));
        const full = inspect(root);
        expect(targeted.rows).toEqual(full.rows);
        expect(targeted.dump).toBe(full.dump);
      } else if (index === 0) {
        cleanTouchedDuringDrift++;
        await port.withFreshGroundingSnapshot(graph => {
          const targeted = inspect(root).rows[0];
          const entity = locateEntity(ids[0]!, { scaffoldRoot })!.entity;
          const full = resolveGrounding(entity.groundsTo[0]!, graph, { fact: `${entity.title}\n\n${entity.body}` });
          expect(JSON.parse(targeted!.resolution!)).toEqual({ ...full, graphRevision: graph.revision });
        }, { sourceScope: new Set(["left.py"]) });
      } else {
        staleTouched++;
        // Full freshness refuses this linked source too: no live verdict is
        // available, so the touched row must say that nothing resolved it.
        expect(result.unavailable).toBe("stale");
        expect(inspect(root).rows[1]!.resolution).toBeNull();
      }
    }
    expect(sourceEdits).toBeGreaterThan(0);
    expect(staleTouched).toBeGreaterThan(0);
    expect(cleanTouchedDuringDrift).toBeGreaterThan(0);
  }, 60_000);
});
