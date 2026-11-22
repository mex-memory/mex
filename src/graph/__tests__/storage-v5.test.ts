import { appendFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryGraphPort } from "../application-adapter.js";
import { runGraphGet, runGraphQuery } from "../cli-agent.js";
import { openGraphDatabase } from "../db/database.js";
import { openSqlite } from "../db/sqlite.js";
import { GraphStore } from "../db/store.js";
import { createGraphEngine } from "../engine-impl.js";
import { FingerprintStore } from "../fingerprint-store.js";
import { rebuildGraph, refreshGraph, type GraphMaintenanceExecutionOptions } from "../maintenance.js";
import { graphEngineBinary } from "../native-engine.js";
import { currentGraphPath, graphLocation, readGraphPointer } from "../storage.js";
import { WarmCheckout } from "../warm.js";

const engineBinary = graphEngineBinary();
let scratch: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

const tsSource = `
interface Worker { work(): number }
class Single implements Worker { work() { return helper(42); } }
class Quiet {
  @tag
  protected static async identity<T>(value: T): Promise<T> { return value; }
  untouched() { return 0; }
}
export function launch(worker: Worker) { return worker.work(); }
export function helper(seed: number) {
  const prepared = [seed + 13, seed + 23, seed + 37, seed + 47];
  return prepared.reduce((total, value) => total + value, seed);
}
export function direct() { return helper(7); }
`;

function fixture(languages = "typescript,javascript"): string {
  scratch = mkdtempSync(join(tmpdir(), "mex-storage-v5-"));
  const root = mkdtempSync(join(scratch, "project-"));
  vi.stubEnv("MEX_HOME", join(scratch, "home"));
  vi.stubEnv("MEX_GRAPH_ENGINE", engineBinary);
  vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", languages);
  vi.stubEnv("MEX_GRAPH_STORAGE", "v5");
  return root;
}

function declaration(root: string, qualified: string): string {
  const db = openGraphDatabase(currentGraphPath(root), { readOnly: true, immutable: true });
  try {
    const rows = db.prepare("SELECT id FROM nodes WHERE qualified_name = ?").all(qualified) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  } finally { db.close(); }
}

async function query(root: string, relation: string, id: string) {
  const lines: string[] = [];
  await runGraphQuery(relation, id, root, { write: line => lines.push(line) }, { fingerprint: true });
  return lines.map(line => JSON.parse(line));
}

describe.skipIf(!engineBinary)("schema v5 with the Rust writer", () => {
  it("serves the same search, symbol, relation, impact and grounded evidence as staged v4", async () => {
    const root = fixture();
    writeFileSync(join(root, "worker.ts"), tsSource);
    vi.stubEnv("MEX_GRAPH_STORAGE", undefined);
    expect((await rebuildGraph(root)).status.schemaVersion).toBe(4);
    const id = declaration(root, "helper");
    const ref = { kind: "symbol", symbolId: id } as const;
    const port = new RepositoryGraphPort(root);
    const read = async () => {
      const workspace = await port.readSymbolWorkspace({
        symbolId: id, source: { maxLines: 20, maxBytes: 4096, limit: 10 },
        callers: { limit: 20 }, callees: { limit: 20 }, impact: { depth: 2, maxNodes: 20 },
      });
      const { revision: _revision, status: _status, ...card } = workspace;
      const graph = createGraphEngine({ rootDir: root, readOnly: true });
      let engine;
      try {
        const method = graph.getNode(declaration(root, "Quiet::identity"))!;
        const { identityKey, updatedAt, ...node } = method;
        engine = {
          node,
          incoming: graph.getIncoming?.(id).map(neighbour => neighbour.edge),
          outgoing: graph.getOutgoing?.(id).map(neighbour => neighbour.edge),
        };
      } finally { graph.close(); }
      const get: string[] = [];
      await runGraphGet([id], root, { write: line => get.push(line) }, { fingerprint: true });
      return {
        card, engine,
        nodes: await port.searchNodes({ query: "worker helper", limit: 40 }),
        source: await port.searchSource({ query: "prepared seed", limit: 20, maxLinesPerMatch: 20, maxBytesPerMatch: 4096 }),
        definition: await port.resolveCodeRef({ ref, maxCandidates: 10 }),
        callers: await query(root, "who-calls", id),
        callees: await query(root, "what-calls", id),
        get: get.map(line => JSON.parse(line)),
        anchor: await port.withFreshGroundingSnapshot(graph => ({ node: graph.getNode(id), fingerprint: graph.getFingerprint(id) })),
      };
    };
    const staged = await read();

    vi.stubEnv("MEX_GRAPH_STORAGE", "v5");
    const result = await refreshGraph(root);
    expect(result).toMatchObject({ status: { status: "fresh", schemaVersion: 5 }, refresh: { mode: "full", filesChanged: 0 } });
    expect(readGraphPointer(graphLocation(root))?.overlay).toBeNull();
    expect(await read()).toEqual(staged);
    const priorBytes = readFileSync(currentGraphPath(root));
    expect(staged.anchor.fingerprint).toMatch(/^mh2:64:/);
    expect(staged.engine.node).toMatchObject({
      isStatic: true, isAsync: true, visibility: "protected", decorators: ["tag"], typeParameters: ["T"],
    });
    expect(readFileSync(currentGraphPath(root))).toEqual(priorBytes);
    const db = openGraphDatabase(currentGraphPath(root), { readOnly: true, immutable: true });
    try {
      expect(db.prepare("SELECT typeof(public_id) AS type, length(public_id) AS size FROM main.nodes LIMIT 1").get())
        .toEqual({ type: "blob", size: 16 });
      expect(db.prepare("SELECT name FROM main.sqlite_schema WHERE name IN ('lsh_buckets', 'file_extraction_cache', 'import_bindings')").all())
        .toEqual([]);
    } finally { db.close(); }

    vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", undefined);
    expect(() => WarmCheckout.open(root)).toThrow(/Schema v5 graphs use a normal graph refresh/);
    vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", "typescript,javascript");
    vi.stubEnv("MEX_GRAPH_STORAGE", undefined);
    expect((await refreshGraph(root)).status.schemaVersion).toBe(4);
    const switched = currentGraphPath(root);
    expect((await refreshGraph(root)).filesIndexed).toBe(0);
    expect(currentGraphPath(root)).toBe(switched);
  });

  it("records one interface implementation and leaves ambiguous dispatch unresolved per symbol", async () => {
    const root = fixture();
    const file = join(root, "worker.ts");
    writeFileSync(file, tsSource);
    await rebuildGraph(root);
    const work = declaration(root, "Single::work");
    const quiet = declaration(root, "Quiet::untouched");
    expect(await query(root, "who-calls", work)).toContainEqual(expect.objectContaining({
      type: "unresolved-reference", name: "work", target: work, candidate: work,
    }));
    expect((await query(root, "who-calls", quiet)).at(-1)).toMatchObject({ type: "summary", status: "no-match" });

    appendFileSync(file, '\nclass Other implements Worker { work() { return 99; } }\nunknown["untouched"]();\n');
    await refreshGraph(root);
    const calls = await query(root, "who-calls", work);
    const dispatch = calls.find(record => record.type === "unresolved-reference");
    expect(dispatch).toMatchObject({ target: work, name: "work" });
    expect(dispatch).not.toHaveProperty("candidate");
    expect(calls.at(-1)).toMatchObject({ type: "summary", status: "partial" });
    expect(await query(root, "who-calls", quiet)).toContainEqual(expect.objectContaining({
      type: "unresolved-reference", name: 'unknown["untouched"]', target: quiet,
    }));
  });

  it("finds a Python candidate even when the call site uses a different name", async () => {
    const root = fixture("python");
    writeFileSync(join(root, "handler.py"), `
class Handler:
    def __call__(self):
        return 42

def execute():
    handler = Handler()
    return handler()
`);
    await rebuildGraph(root);
    const id = declaration(root, "Handler::__call__");
    expect(await query(root, "who-calls", id)).toContainEqual(expect.objectContaining({
      type: "unresolved-reference", target: id, name: "handler", candidate: id,
    }));
  });

  it("carries historical baselines across the switch and reconciles a moved declaration without LSH", async () => {
    const root = fixture();
    vi.stubEnv("MEX_GRAPH_STORAGE", undefined);
    const file = join(root, "before.ts");
    writeFileSync(file, `export function helper(seed: number) {
  const large = seed * 75671 + (seed % 18313) ** 2;
  const small = (seed + 56437) / (45739 + seed);
  return (large + small) * 89497 - seed * 23549;
}
`);
    await rebuildGraph(root);
    const id = declaration(root, "helper");
    const db = openGraphDatabase(currentGraphPath(root), { allowV5ContinuityWrites: true });
    const subject = { kind: "entity", id: "mx_test" } as const;
    let hash: string;
    let fingerprint: string;
    try {
      const store = new GraphStore(db);
      const node = store.getNodeById(id)!;
      hash = node.bodyHash!;
      const port = new RepositoryGraphPort(root);
      fingerprint = (await port.withFreshGroundingSnapshot(graph => graph.getFingerprint(id)))!;
      new FingerprintStore(db).saveBaseline({ subject, nodeId: id, source: "original body", bodyHash: hash, fingerprint });
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }

    vi.stubEnv("MEX_GRAPH_STORAGE", "v5");
    renameSync(file, join(root, "after.ts"));
    const result = await refreshGraph(root);
    expect(result.status).toMatchObject({ schemaVersion: 5, status: "fresh" });
    const moved = declaration(root, "helper");
    expect(moved).not.toBe(id);
    const port = new RepositoryGraphPort(root);
    await port.withFreshGroundingSnapshot(snapshot => {
      expect(snapshot.getBaselineSource(subject, moved)).toMatchObject({ nodeId: id, bodyHash: hash, fingerprint });
      expect(snapshot.reconcile(id, fingerprint, hash)).toEqual({ kind: "MOVED", nodeId: moved });
    });

    vi.stubEnv("MEX_GRAPH_STORAGE", undefined);
    expect((await refreshGraph(root)).status.schemaVersion).toBe(4);
    expect(await port.withFreshGroundingSnapshot(snapshot => snapshot.getBaselineSource(subject, moved)))
      .toMatchObject({ nodeId: id, bodyHash: hash, fingerprint });
  });

  it("validates v5 Health and preserves the prior base after candidate damage", async () => {
    const root = fixture();
    const file = join(root, "worker.ts");
    writeFileSync(file, tsSource);
    expect((await rebuildGraph(root)).status).toMatchObject({ schemaVersion: 5, parseHealth: { total: 1, ok: 1 } });
    const prior = currentGraphPath(root);
    const bytes = readFileSync(prior);
    appendFileSync(file, "\nexport const incomplete = [\n");
    const corrupt = { __internal: { afterCandidateBuilt(path: string) {
      const db = openSqlite(path);
      try { db.exec("DROP INDEX unresolved_calls_candidate"); } finally { db.close(); }
    } } } as GraphMaintenanceExecutionOptions;
    await expect(refreshGraph(root, corrupt)).rejects.toMatchObject({
      code: "GRAPH_CANDIDATE_INVALID",
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "GRAPH_INDEX_SCHEMA_INVALID" })]),
    });
    expect(currentGraphPath(root)).toBe(prior);
    expect(readFileSync(prior)).toEqual(bytes);
    expect(readdirSync(graphLocation(root).directory).filter(name => name.startsWith("graph-tmp-") || name === "graph.lock")).toEqual([]);
    const abort = new AbortController();
    const cancel = { signal: abort.signal, __internal: { afterCandidateValidated() {
      abort.abort();
    } } } as GraphMaintenanceExecutionOptions;
    await expect(refreshGraph(root, cancel)).rejects.toMatchObject({ code: "GRAPH_MAINTENANCE_CANCELLED" });
    expect(currentGraphPath(root)).toBe(prior);
    expect((await refreshGraph(root)).status).toMatchObject({ schemaVersion: 5, status: "degraded", parseHealth: { partial: 1 } });
  });

  it("uses v4 for a corpus containing a non-engine language", async () => {
    const root = fixture();
    writeFileSync(join(root, "worker.ts"), tsSource);
    writeFileSync(join(root, "legacy.py"), "def legacy():\n    return 1\n");
    const result = await rebuildGraph(root);
    expect(result.status.schemaVersion).toBe(4);
    expect(result.engine).toMatchObject({ files: 1, fallbackFiles: 0 });
  });
});
