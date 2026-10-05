import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MexPortError } from "../../team/contracts/shared.js";
import {
  createRepositoryGraphPort,
  type RepositoryGraphGroundingSnapshot,
  type GraphSearchBundleResult,
} from "../application-adapter.js";
import { openSqlite } from "../db/sqlite.js";
import { FingerprintStore } from "../fingerprint-store.js";
import { serializeFingerprint } from "../fingerprint.js";
import { loadFreshGraphReadSession } from "../read-session.js";
import { GraphMaintenanceError } from "../maintenance.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-application-adapter-"));
  roots.push(root);
  return root;
}

function source(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

async function fixture(): Promise<{
  root: string;
  port: ReturnType<typeof createRepositoryGraphPort>;
}> {
  const root = temporaryRoot();
  source(root, ".gitignore", ".mex/graph.db*\n");
  source(root, "src/service.ts", [
    "export function serviceTarget(input: number): number {",
    "  const doubled = input * 2;",
    "  const adjusted = doubled + 7;",
    "  return adjusted > 20 ? adjusted - 3 : adjusted + 3;",
    "}",
    "",
    "export function serviceCaller(): number {",
    "  return serviceTarget(10);",
    "}",
    "",
    "export function serviceOther(): number {",
    "  return serviceTarget(5);",
    "}",
    "",
  ].join("\n"));
  source(root, "src/auxiliary.ts", [
    "export function serviceAuxiliary(input: number): number {",
    "  const normalized = input + 1;",
    "  return normalized * 3;",
    "}",
    "",
  ].join("\n"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Adapter Test");
  git(root, "config", "user.email", "adapter@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  const port = createRepositoryGraphPort(root);
  await port.rebuild();
  return { root, port };
}

function expectPortCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(MexPortError);
  expect((error as MexPortError).problem.code).toBe(code);
}

describe("RepositoryGraphPort grounding evidence", () => {
  it("explains a layout-only edit through a fresh snapshot, grammars loaded", async () => {
    const { root, port } = await fixture();
    const { createGraphEngine } = await import("../engine-impl.js");
    const engine = createGraphEngine({ rootDir: root });
    const id = engine.searchNodes("serviceTarget").find((node) => node.name === "serviceTarget")!.id;
    engine.close();
    const committed = await port.withFreshGroundingSnapshot((snapshot) => {
      const node = snapshot.getNode(id)!;
      snapshot.rememberBody(id, node.bodyHash!);
      return { bodyHash: node.bodyHash! };
    });

    source(root, "src/service.ts", readFileSync(join(root, "src/service.ts"), "utf8")
      .replace("  const doubled = input * 2;", "  // doubled first\n  const doubled = input * 2")
      .replace("const adjusted = doubled + 7;", "const adjusted = doubled + 7"));
    git(root, "commit", "-qam", "format");
    await port.refresh();

    const evidence = await port.withFreshGroundingSnapshot((snapshot) => snapshot.explainChange(committed, id));
    expect(evidence).toMatchObject({ commentOnly: false, layoutOnly: true });
    expect(evidence?.oldBody).toContain("input * 2;");
  });
});

describe("RepositoryGraphPort", () => {
  it.each([undefined, "process"] as const)("forwards maintenance authority with execution mode %s", async (candidateExecution) => {
    const root = temporaryRoot();
    const refresh = vi.fn(async () => { throw new Error("injected stop"); });
    const rebuild = vi.fn(async () => { throw new Error("injected stop"); });
    const port = createRepositoryGraphPort(root, {
      candidateExecution,
      __internal: { refresh, rebuild },
    });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const options = { signal: controller.signal, onProgress };
    await expect(port.refresh(options)).rejects.toBeInstanceOf(MexPortError);
    await expect(port.rebuild(options)).rejects.toBeInstanceOf(MexPortError);
    const forwarded = candidateExecution ? { ...options, candidateExecution } : options;
    expect(refresh).toHaveBeenCalledExactlyOnceWith(root, forwarded);
    expect(rebuild).toHaveBeenCalledExactlyOnceWith(root, forwarded);
  });

  it("maps a non-lossless repair state to sanitized rebuild guidance", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = true;\n");
    const port = createRepositoryGraphPort(root, {
      __internal: {
        refresh: async () => {
          throw new GraphMaintenanceError(
            "GRAPH_INDEX_NOT_REPAIRABLE",
            `unsafe lineage at ${root}/.mex/graph.db`,
          );
        },
      },
    });

    await expect(port.refresh()).rejects.toSatisfy((error) => {
      expectPortCode(error, "MIGRATION_REQUIRED");
      const problem = (error as MexPortError).problem;
      expect(problem.status).toBe(409);
      expect(problem.detail).toContain("Rebuild");
      expect(problem.detail).not.toContain(root);
      return true;
    });
  });

  it("keeps missing status read-only and maps unavailable reads", async () => {
    const root = temporaryRoot();
    source(root, "src/empty.ts", "export const empty = true;\n");
    const port = createRepositoryGraphPort(root);

    await expect(port.inspectStatus()).resolves.toMatchObject({ status: "missing" });
    await expect(port.searchNodes({ query: "empty", limit: 1 })).rejects.toSatisfy((error) => {
      expectPortCode(error, "INDEX_MISSING");
      return true;
    });
  });

  it("projects search, source, relations, impact, and workspace from one fresh snapshot", async () => {
    const { port } = await fixture();
    const status = await port.inspectStatus();
    expect(status.status).toBe("fresh");

    const nodes = await port.searchNodes({ query: "service", limit: 2 });
    expect(nodes.items).toHaveLength(2);
    expect(nodes.nextCursor).toEqual(expect.any(String));
    const second = await port.searchNodes({
      query: "service",
      limit: 2,
      cursor: nodes.nextCursor!,
    });
    expect(new Set([...nodes.items, ...second.items].map((item) => item.ref.symbolId)).size)
      .toBe(nodes.items.length + second.items.length);

    const target = (await port.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const caller = (await port.searchNodes({ query: "serviceCaller", limit: 1 })).items[0]!;
    await expect(port.getNode(target.ref.symbolId)).resolves.toEqual(target);

    const sourcePage = await port.readSource({
      ref: target.ref,
      maxLines: 1,
      maxBytes: 256,
      limit: 1,
    });
    expect(sourcePage.items[0]).toMatchObject({
      path: "src/service.ts",
      startLine: target.startLine,
      endLine: target.startLine,
    });
    expect(sourcePage.nextCursor).toEqual(expect.any(String));
    const sourceContinuation = await port.readSource({
      ref: target.ref,
      maxLines: 1,
      maxBytes: 256,
      limit: 1,
      cursor: sourcePage.nextCursor!,
    });
    expect(sourceContinuation.items[0]!.startLine).toBeGreaterThan(target.startLine);

    const callers = await port.getCallers({ symbolId: target.ref.symbolId, limit: 10 });
    expect(callers.items.some((item) => item.source.symbolId === caller.ref.symbolId)).toBe(true);
    const callees = await port.getCallees({ symbolId: caller.ref.symbolId, limit: 10 });
    expect(callees.items.some((item) => item.target.symbolId === target.ref.symbolId)).toBe(true);

    const impact = await port.getImpact({ ref: target.ref, depth: 2, maxNodes: 20 });
    expect(impact.roots[0]?.ref.symbolId).toBe(target.ref.symbolId);
    expect(impact.impacted.some((item) => item.symbol.ref.symbolId === caller.ref.symbolId)).toBe(true);

    const workspace = await port.readSymbolWorkspace({
      symbolId: target.ref.symbolId,
      source: { maxLines: 20, maxBytes: 4096 },
      callers: { limit: 10 },
      impact: { depth: 1, maxNodes: 20 },
    });
    expect(workspace.symbol.ref.symbolId).toBe(target.ref.symbolId);
    expect(workspace.source.items).toHaveLength(1);
    expect(workspace.callers?.items.length).toBeGreaterThan(0);
    expect(workspace.callees).toBeNull();
    expect(workspace.impact?.roots).toHaveLength(1);

    const callersSource = await port.readSymbolWorkspace({
      symbolId: target.ref.symbolId,
      workspaceView: "callers",
      source: { maxLines: 1, maxBytes: 256 },
      callers: { limit: 10 },
    });
    expect(callersSource.source.nextCursor).toEqual(expect.any(String));
    await expect(port.readSymbolWorkspace({
      symbolId: target.ref.symbolId,
      workspaceView: "impact",
      source: {
        maxLines: 1,
        maxBytes: 256,
        cursor: callersSource.source.nextCursor!,
      },
      impact: { depth: 1, maxNodes: 20 },
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "VALIDATION_FAILED");
      return true;
    });
  }, 20_000);

  it("isolates request-specific bundle cursor errors while retaining the other group", async () => {
    const { port } = await fixture();

    const result: GraphSearchBundleResult = await port.searchBundle({
      nodes: { query: "service", cursor: "not-a-cursor", limit: 1 },
      sources: {
        query: "service",
        maxLinesPerMatch: 10,
        maxBytesPerMatch: 1024,
        limit: 2,
      },
    });

    expect(result.nodes).toMatchObject({
      ok: false,
      problem: { code: "VALIDATION_FAILED" },
    });
    expect(result.sources.ok).toBe(true);
    if (result.sources.ok) {
      expect(result.sources.value.items.length).toBeGreaterThan(0);
      expect(result.sources.value.items[0]).toMatchObject({
        linesTruncated: expect.any(Boolean),
        bytesTruncated: expect.any(Boolean),
      });
    }
  }, 20_000);

  it("reports exact source clipping and binds every paginated cursor to its limit", async () => {
    const { port } = await fixture();
    const expectLimitConflict = async (operation: Promise<unknown>) => {
      await expect(operation).rejects.toSatisfy((error) => {
        expectPortCode(error, "VALIDATION_FAILED");
        return true;
      });
    };

    const lineClipped = await port.searchSource({
      query: "service",
      maxLinesPerMatch: 1,
      maxBytesPerMatch: 4_096,
      limit: 1,
    });
    expect(lineClipped.items[0]).toMatchObject({ linesTruncated: true, bytesTruncated: false });
    expect(lineClipped.nextCursor).toEqual(expect.any(String));
    await expectLimitConflict(port.searchSource({
      query: "service",
      maxLinesPerMatch: 1,
      maxBytesPerMatch: 4_096,
      limit: 2,
      cursor: lineClipped.nextCursor!,
    }));

    const byteClipped = await port.searchSource({
      query: "service",
      maxLinesPerMatch: 40,
      maxBytesPerMatch: 1,
      limit: 1,
    });
    expect(byteClipped.items[0]).toMatchObject({ bytesTruncated: true });

    const nodes = await port.searchNodes({ query: "service", limit: 1 });
    expect(nodes.nextCursor).toEqual(expect.any(String));
    await expectLimitConflict(port.searchNodes({
      query: "service",
      limit: 2,
      cursor: nodes.nextCursor!,
    }));

    const target = (await port.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const sourcePage = await port.readSource({
      ref: target.ref,
      maxLines: 1,
      maxBytes: 256,
      limit: 1,
    });
    expect(sourcePage.nextCursor).toEqual(expect.any(String));
    await expectLimitConflict(port.readSource({
      ref: target.ref,
      maxLines: 1,
      maxBytes: 256,
      limit: 2,
      cursor: sourcePage.nextCursor!,
    }));

    const callers = await port.getCallers({ symbolId: target.ref.symbolId, limit: 1 });
    expect(callers.nextCursor).toEqual(expect.any(String));
    await expectLimitConflict(port.getCallers({
      symbolId: target.ref.symbolId,
      limit: 2,
      cursor: callers.nextCursor!,
    }));
  }, 30_000);

  it("binds cursors to both the request and exact graph snapshot", async () => {
    const { root, port } = await fixture();
    const first = await port.searchNodes({ query: "service", limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));

    await expect(port.searchNodes({
      query: "serviceTarget",
      limit: 1,
      cursor: first.nextCursor!,
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "VALIDATION_FAILED");
      return true;
    });

    source(root, "src/service.ts", [
      "export function serviceTarget(input: number): number { return input * 4; }",
      "export function serviceCaller(): number { return serviceTarget(10); }",
      "export function serviceOther(): number { return serviceTarget(5); }",
      "",
    ].join("\n"));
    git(root, "add", "src/service.ts");
    git(root, "commit", "-qm", "change fixture");
    await port.rebuild();

    await expect(port.searchNodes({
      query: "service",
      limit: 1,
      cursor: first.nextCursor!,
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "REVISION_CONFLICT");
      return true;
    });
  }, 30_000);

  it("resolves symbol and file grounding without leaking persisted rows", async () => {
    const { root, port } = await fixture();
    const target = (await port.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const db = openSqlite(join(root, ".mex", "graph.db"), { readOnly: true, immutable: true });
    const current = new FingerprintStore(db).get(target.ref.symbolId);
    db.close();
    expect(current).not.toBeNull();
    const fingerprint = serializeFingerprint(current!);

    await expect(port.resolveCodeRef({
      ref: { ...target.ref, fingerprint },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "resolved", health: "fresh" });
    await expect(port.resolveCodeRef({
      ref: { ...target.ref, fingerprint: `${fingerprint}00` },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "unverified", health: "unverified" });
    await expect(port.resolveCodeRef({
      ref: { kind: "symbol", symbolId: "function:missing", fingerprint },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "resolved", health: "fresh" });
    await expect(port.resolveCodeRef({
      ref: { kind: "file", path: "src/service.ts" },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "resolved", health: "fresh" });
    await expect(port.resolveCodeRef({
      ref: { kind: "file", path: "src/service.ts", fingerprint: "not-a-sha256" },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "unverified", health: "unverified" });
    await expect(port.resolveCodeRef({
      ref: { kind: "file", path: "../outside.ts" },
      maxCandidates: 5,
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "PATH_OUTSIDE_PROJECT");
      return true;
    });
  }, 20_000);

  it("discards buffered output when final freshness revalidation fails", async () => {
    const { root } = await fixture();
    const port = createRepositoryGraphPort(root, {
      __internal: {
        loadFresh: async (...args) => {
          const loaded = await loadFreshGraphReadSession(...args);
          if (!loaded.session) return loaded;
          return {
            ...loaded,
            session: {
              ...loaded.session,
              revalidateFreshness: async () => ({
                valid: false,
                code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
                message: "test race",
                graphStatus: loaded.graphStatus,
              }),
            },
          };
        },
      },
    });

    await expect(port.searchNodes({ query: "service", limit: 1 })).rejects.toSatisfy((error) => {
      expectPortCode(error, "OPERATION_INTERRUPTED");
      expect((error as MexPortError).problem.detail).not.toContain("test race");
      return true;
    });
  }, 20_000);

  it("projects at most 50 direct grounding symbols without source reads or alias substitution", async () => {
    const { root, port: basePort } = await fixture();
    const target = (await basePort.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const caller = (await basePort.searchNodes({ query: "serviceCaller", limit: 1 })).items[0]!;
    let loads = 0;
    let lookups = 0;
    let sourceReads = 0;
    const port = createRepositoryGraphPort(root, {
      __internal: {
        loadFresh: async (...args) => {
          loads += 1;
          const loaded = await loadFreshGraphReadSession(...args);
          if (!loaded.session) return loaded;
          const originalGraph = loaded.session.graph;
          const graph = new Proxy(originalGraph, {
            get(targetGraph, property, receiver) {
              if (property === "getNode") {
                return (id: string) => {
                  lookups += 1;
                  const node = originalGraph.getNode(id === "function:alias" ? target.ref.symbolId : id);
                  return node === null ? null : { ...node, signature: "x".repeat(5_000) };
                };
              }
              return Reflect.get(targetGraph, property, receiver);
            },
          });
          return {
            ...loaded,
            session: {
              ...loaded.session,
              graph,
              readIndexedSource() {
                sourceReads += 1;
                throw new Error("Compact symbols must not request source bodies.");
              },
            },
          };
        },
      },
    });

    const symbols = await port.withFreshGroundingSnapshot((snapshot) => {
      const result = snapshot.getSymbols([
        caller.ref.symbolId,
        "function:missing",
        target.ref.symbolId,
        caller.ref.symbolId,
        "function:alias",
      ]);
      expect(lookups).toBe(4);
      expect(snapshot.getSymbols(Array.from({ length: 50 }, () => target.ref.symbolId))).toHaveLength(1);
      expect(snapshot.getSymbols([])).toEqual([]);
      const beforeInvalidRequests = lookups;
      for (const ids of [
        Array.from({ length: 51 }, () => target.ref.symbolId),
        [target.ref.symbolId, "unsafe/id"],
        null as unknown as readonly string[],
      ]) {
        expect(() => snapshot.getSymbols(ids)).toThrowError(MexPortError);
        try {
          snapshot.getSymbols(ids);
        } catch (error) {
          expectPortCode(error, "VALIDATION_FAILED");
        }
      }
      expect(lookups).toBe(beforeInvalidRequests);
      return result;
    });

    expect(loads).toBe(1);
    expect(sourceReads).toBe(0);
    expect(symbols.map((symbol) => symbol.ref.symbolId)).toEqual([caller.ref.symbolId, target.ref.symbolId]);
    expect(symbols[0]).toEqual({ ...caller, signature: "x".repeat(4 * 1024) });
    expect(symbols[1]).toEqual({ ...target, signature: "x".repeat(4 * 1024) });
    expect(symbols.every((symbol) => !Object.hasOwn(symbol, "bodyHash")
      && !Object.hasOwn(symbol, "fingerprint") && !Object.hasOwn(symbol, "docstring")
      && !Object.hasOwn(symbol, "content"))).toBe(true);
  }, 30_000);

  it("holds one fresh grounding snapshot through async work and discards it on source invalidation", async () => {
    const { root, port: basePort } = await fixture();
    const target = (await basePort.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    let escaped: RepositoryGraphGroundingSnapshot | null = null;
    let callbackSettled = false;
    const port = createRepositoryGraphPort(root, {
      __internal: {
        loadFresh: async (...args) => {
          const loaded = await loadFreshGraphReadSession(...args);
          if (!loaded.session) return loaded;
          const revalidateFreshness = loaded.session.revalidateFreshness.bind(loaded.session);
          return {
            ...loaded,
            session: {
              ...loaded.session,
              revalidateFreshness: async () => {
                expect(callbackSettled).toBe(true);
                return revalidateFreshness();
              },
            },
          };
        },
      },
    });
    callbackSettled = false;
    const projection = await port.withFreshGroundingSnapshot(async (snapshot) => {
      escaped = snapshot;
      const node = snapshot.getNode(target.ref.symbolId);
      const symbols = snapshot.getSymbols([target.ref.symbolId]);
      const fingerprint = snapshot.getFingerprint(target.ref.symbolId);
      await Promise.resolve();
      callbackSettled = true;
      return { node, symbols, fingerprint };
    });
    expect(projection.node).toMatchObject({
      id: target.ref.symbolId,
      filePath: "src/service.ts",
    });
    expect(projection.fingerprint).toEqual(expect.any(String));
    expect(projection.symbols).toEqual([target]);
    expect(() => escaped!.getNode(target.ref.symbolId)).toThrowError(MexPortError);
    expect(() => escaped!.getSymbols([target.ref.symbolId])).toThrowError(MexPortError);
    try {
      escaped!.getNode(target.ref.symbolId);
    } catch (error) {
      expectPortCode(error, "OPERATION_INTERRUPTED");
      expect((error as MexPortError).problem.detail).not.toContain(root);
    }

    callbackSettled = false;
    await expect(port.withFreshGroundingSnapshot(async (snapshot) => {
      const buffered = snapshot.getSymbols([target.ref.symbolId]);
      source(root, "src/service.ts", "export const changedDuringGrounding = true;\n");
      await Promise.resolve();
      callbackSettled = true;
      return buffered;
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "OPERATION_INTERRUPTED");
      return true;
    });
  }, 30_000);

  it("brands grounding accessor failures as sanitized interrupted Graph reads", async () => {
    const { root } = await fixture();
    const port = createRepositoryGraphPort(root, {
      __internal: {
        loadFresh: async (...args) => {
          const loaded = await loadFreshGraphReadSession(...args);
          if (!loaded.session) return loaded;
          const graph = new Proxy(loaded.session.graph, {
            get(target, property, receiver) {
              if (property === "getNode") {
                return () => {
                  throw new Error(`raw graph accessor failure at ${root}`);
                };
              }
              return Reflect.get(target, property, receiver);
            },
          });
          return {
            ...loaded,
            session: { ...loaded.session, graph },
          };
        },
      },
    });

    await expect(port.withFreshGroundingSnapshot((snapshot) => {
      snapshot.getNode("function:1111111111111111");
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "OPERATION_INTERRUPTED");
      expect((error as MexPortError).problem.detail).not.toContain(root);
      expect((error as MexPortError).problem.detail).not.toContain("raw graph accessor failure");
      return true;
    });
    await expect(port.withFreshGroundingSnapshot((snapshot) => {
      snapshot.getSymbols(["function:1111111111111111"]);
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "OPERATION_INTERRUPTED");
      expect((error as MexPortError).problem.detail).not.toContain(root);
      expect((error as MexPortError).problem.detail).not.toContain("raw graph accessor failure");
      return true;
    });
  }, 30_000);

  it("commits prepared grounding work only after final Graph validation and discards on invalidation", async () => {
    const { root } = await fixture();
    let revalidated = false;
    let committed = false;
    let discarded = false;
    const stable = createRepositoryGraphPort(root, {
      __internal: {
        loadFresh: async (...args) => {
          const loaded = await loadFreshGraphReadSession(...args);
          if (!loaded.session) return loaded;
          const revalidateFreshness = loaded.session.revalidateFreshness.bind(loaded.session);
          return {
            ...loaded,
            session: {
              ...loaded.session,
              revalidateFreshness: async () => {
                const result = await revalidateFreshness();
                revalidated = true;
                return result;
              },
            },
          };
        },
      },
    });

    await expect(stable.withFreshGroundingPublication(async (snapshot) => {
      expect(snapshot.getNode("function:missing")).toBeNull();
      return {
        preflight() {
          expect(revalidated).toBe(false);
        },
        commit() {
          expect(revalidated).toBe(true);
          committed = true;
          return "published";
        },
        discard() {
          discarded = true;
        },
      };
    })).resolves.toBe("published");
    expect({ committed, discarded }).toEqual({ committed: true, discarded: false });

    committed = false;
    discarded = false;
    const unstable = createRepositoryGraphPort(root, {
      __internal: {
        loadFresh: async (...args) => {
          const loaded = await loadFreshGraphReadSession(...args);
          if (!loaded.session) return loaded;
          return {
            ...loaded,
            session: {
              ...loaded.session,
              revalidateFreshness: async () => ({
                valid: false,
                code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
                message: "private-test-race",
                graphStatus: loaded.graphStatus,
              }),
            },
          };
        },
      },
    });
    await expect(unstable.withFreshGroundingPublication(async () => ({
      preflight() {},
      commit() {
        committed = true;
        return "must-not-publish";
      },
      discard() {
        discarded = true;
      },
    }))).rejects.toSatisfy((error) => {
      expectPortCode(error, "OPERATION_INTERRUPTED");
      return true;
    });
    expect({ committed, discarded }).toEqual({ committed: false, discarded: true });

    const callbackFailure = new Error("wiki-preparation-failed");
    await expect(stable.withFreshGroundingSnapshot(async () => {
      throw callbackFailure;
    })).rejects.toBe(callbackFailure);

    const preflightFailure = new Error("wiki-preflight-failed");
    discarded = false;
    await expect(stable.withFreshGroundingPublication(async () => ({
      preflight() {
        throw preflightFailure;
      },
      commit() {
        return "must-not-publish";
      },
      discard() {
        discarded = true;
      },
    }))).rejects.toBe(preflightFailure);
    expect(discarded).toBe(true);
  }, 30_000);

  it("fails closed on out-of-range confidence and unknown relation provenance", async () => {
    const { root, port } = await fixture();
    const target = (await port.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const dbPath = join(root, ".mex", "graph.db");
    const updateRelation = (confidence: number, provenance: string) => {
      const db = openSqlite(dbPath);
      try {
        db.prepare(
          "UPDATE edges SET confidence = ?, provenance = ? WHERE kind = 'calls'",
        ).run(confidence, provenance);
      } finally {
        db.close();
      }
    };

    updateRelation(1.01, "tree-sitter");
    await expect(port.getCallers({ symbolId: target.ref.symbolId, limit: 10 }))
      .rejects.toSatisfy((error) => {
        expectPortCode(error, "INDEX_CORRUPT");
        return true;
      });

    updateRelation(0.9, "untrusted-provenance");
    await expect(port.getCallers({ symbolId: target.ref.symbolId, limit: 10 }))
      .rejects.toSatisfy((error) => {
        expectPortCode(error, "INDEX_CORRUPT");
        expect((error as MexPortError).problem.detail).not.toContain("untrusted-provenance");
        return true;
      });
  }, 20_000);
});
