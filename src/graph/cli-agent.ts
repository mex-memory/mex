import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createGraphEngine } from "./engine-impl.js";
import type { GraphEngine } from "./engine.js";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import type { GraphNode } from "./types.js";
import {
  compactFact, groupByFile, readNodeSource, scopeSelect,
  type CompactFact, type DetailLevel, type SourceRange,
} from "./scope.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { serializeFingerprint } from "./fingerprint.js";
import { BudgetedEmitter, resolveOptions, SCHEMA_VERSION, type AgentOptions } from "./agent-protocol.js";

type QueryRelation = "who-calls" | "what-calls" | "where-defined";

interface AgentGraphSession {
  graph: GraphEngine;
  db: SqliteDatabase;
  close(): void;
}

export interface AgentCommandDeps {
  open?: (rootDir: string) => AgentGraphSession;
  write?: (line: string) => void;
}

type RawOptions = Partial<Record<keyof AgentOptions, unknown>>;

/** Agent-facing blast radius. Output is newline-delimited JSON (JSONL). */
export function runImpact(
  target: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const fileNodes = nodesForFile(session, rootDir, target);
    const roots = fileNodes.length > 0 ? fileNodes : resolveSymbol(session.graph, target);
    if (roots.length === 0) {
      writeJson(write, { type: "error", code: "TARGET_NOT_FOUND", target });
      return;
    }
    if (fileNodes.length === 0 && roots.length > 1) {
      writeJson(write, { type: "error", code: "TARGET_AMBIGUOUS", target, candidates: roots.map(nodeRef) });
      return;
    }

    const emitter = new BudgetedEmitter(write, opts.maxOutputTokens);
    emitter.force(metaRecord("impact", opts));
    emitter.force({ type: "target", targetType: fileNodes.length > 0 ? "file" : "symbol", value: target });

    const emitted: GraphNode[] = [];
    for (const root of roots.sort(byId)) {
      const fact = factFor(session, root.id, opts.detail, opts.fingerprint);
      if (fact) emitter.offer({ type: "defines", ...fact });
      emitted.push(root);
    }

    const impacted = new Map<string, { node: GraphNode; depth: number; root: string }>();
    for (const root of roots.sort(byId)) {
      for (const entry of transitiveCallers(session.graph, root, opts.depth)) {
        const current = impacted.get(entry.node.id);
        if (!current || entry.depth < current.depth) impacted.set(entry.node.id, { ...entry, root: root.id });
      }
    }

    const ordered = [...impacted.values()].sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id));
    let truncated = false;
    for (const entry of ordered) {
      if (emitted.length - roots.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, entry.node.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      if (!emitter.offer({ type: "caller", depth: entry.depth, root: entry.root, ...fact })) { truncated = true; break; }
      emitted.push(entry.node);
    }

    if (opts.detail === "source" && !emitSourceGrouped(emitter, emitted, rootDir, opts.maxSourceLines)) truncated = true;

    const affectedIds = [...new Set([...roots.map((node) => node.id), ...impacted.keys()])];
    for (const grounding of groundedFiles(session.db, affectedIds)) {
      emitter.offer({ type: "grounding", node: grounding.node_id, file: grounding.scaffold_file });
    }

    emitter.force(summaryRecord(emitter, opts, {
      matchedNodes: roots.length + impacted.size,
      returnedNodes: emitted.length,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: emitted.length > 0 ? [`mex graph get ${emitted[0]!.id} --detail source`] : [],
    }));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Structural graph lookup. Output is newline-delimited JSON (JSONL). */
export function runGraphQuery(
  relation: string,
  target: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  if (!isRelation(relation)) {
    writeJson(write, { type: "error", code: "INVALID_QUERY", relation, expected: ["who-calls", "what-calls", "where-defined"] });
    return;
  }
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const nodes = resolveSymbol(session.graph, target);
    if (nodes.length === 0) {
      writeJson(write, { type: "error", code: "TARGET_NOT_FOUND", target });
      return;
    }

    const resultNodes: GraphNode[] = [];
    for (const node of nodes.sort(byId)) {
      if (relation === "where-defined") { resultNodes.push(node); continue; }
      const related = relation === "who-calls" ? session.graph.getCallers(node.id) : session.graph.getCallees(node.id);
      for (const entry of related.sort(byId)) resultNodes.push(entry);
    }
    const unique = dedupeById(resultNodes);

    const emitter = new BudgetedEmitter(write, opts.maxOutputTokens);
    emitter.force(metaRecord(`graph query ${relation}`, opts));

    const emitted: GraphNode[] = [];
    let truncated = false;
    for (const node of unique) {
      if (emitted.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, node.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      if (!emitter.offer({ type: "result", relation, ...fact })) { truncated = true; break; }
      emitted.push(node);
    }

    if (opts.detail === "source" && !emitSourceGrouped(emitter, emitted, rootDir, opts.maxSourceLines)) truncated = true;

    emitter.force(summaryRecord(emitter, opts, {
      matchedNodes: unique.length,
      returnedNodes: emitted.length,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: emitted.length > 0 && opts.detail !== "source" ? [`mex graph get ${emitted[0]!.id} --detail source`] : [],
    }));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Broad graph retrieval for an agent task. Compact JSONL manifest by default. */
export function runGraphScope(
  task: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const candidateIds = scopeSelect(session.graph, task);
    const emitter = new BudgetedEmitter(write, opts.maxOutputTokens);
    emitter.force(metaRecord("graph scope", opts, task));

    const returnedIds = new Set<string>();
    const returnedNodes: GraphNode[] = [];
    let truncated = false;
    for (const id of candidateIds) {
      if (returnedNodes.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      if (!emitter.offer({ type: "fact", ...fact })) { truncated = true; break; }
      returnedIds.add(id);
      const node = session.graph.getNode(id);
      if (node) returnedNodes.push(node);
    }

    let returnedEdges = 0;
    if (opts.detail !== "minimal") returnedEdges = emitInSetEdges(emitter, session.graph, returnedIds);
    if (opts.detail === "source" && !emitSourceGrouped(emitter, returnedNodes, rootDir, opts.maxSourceLines)) truncated = true;

    emitter.force(summaryRecord(emitter, opts, {
      matchedNodes: candidateIds.length,
      returnedNodes: returnedNodes.length,
      returnedEdges,
      truncated,
      suggestedNextCommands: buildScopeSuggestions(returnedNodes, opts.detail),
    }));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Targeted source expansion by node id. Output is JSONL source records. */
export function runGraphGet(
  ids: string[],
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions({ ...rawOptions, detail: "source" });
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const emitter = new BudgetedEmitter(write, opts.maxOutputTokens);
    emitter.force({
      type: "meta", schemaVersion: SCHEMA_VERSION, command: "graph get",
      detail: "source", maxNodes: ids.length, maxOutputTokens: opts.maxOutputTokens,
    });

    const nodes: GraphNode[] = [];
    for (const id of ids) {
      const node = session.graph.getNode(id);
      if (!node) { emitter.force({ type: "error", code: "NODE_NOT_FOUND", id }); continue; }
      nodes.push(node);
    }
    const truncated = !emitSourceGrouped(emitter, nodes, rootDir, opts.maxSourceLines);

    emitter.force(summaryRecord(emitter, opts, {
      matchedNodes: ids.length,
      returnedNodes: nodes.length,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: [],
    }));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

// ── shared helpers ──────────────────────────────────────────────────────────

function metaRecord(command: string, opts: AgentOptions, task?: string): Record<string, unknown> {
  return {
    type: "meta", schemaVersion: SCHEMA_VERSION, command,
    ...(task !== undefined ? { task } : {}),
    detail: opts.detail, maxNodes: opts.maxNodes, maxOutputTokens: opts.maxOutputTokens,
  };
}

function summaryRecord(
  emitter: BudgetedEmitter,
  opts: AgentOptions,
  fields: { matchedNodes: number; returnedNodes: number; returnedEdges: number; truncated: boolean; suggestedNextCommands: string[] },
): Record<string, unknown> {
  return {
    type: "summary",
    matchedNodes: fields.matchedNodes,
    returnedNodes: fields.returnedNodes,
    returnedEdges: fields.returnedEdges,
    estimatedOutputTokens: emitter.estimatedTokens,
    maxOutputTokens: opts.maxOutputTokens,
    truncated: fields.truncated,
    suggestedNextCommands: fields.suggestedNextCommands,
  };
}

/** Emit `calls` edges whose endpoints are both in the returned set. Returns the count. */
function emitInSetEdges(emitter: BudgetedEmitter, graph: GraphEngine, returnedIds: Set<string>): number {
  let count = 0;
  for (const sourceId of returnedIds) {
    for (const callee of graph.getCallees(sourceId)) {
      if (!returnedIds.has(callee.id)) continue;
      if (emitter.offer({ type: "edge", kind: "calls", source: sourceId, target: callee.id, provenance: "static" })) count++;
    }
  }
  return count;
}

/** Emit source once per file for the given nodes. Returns false if a record was budget-dropped. */
function emitSourceGrouped(emitter: BudgetedEmitter, nodes: GraphNode[], rootDir: string, maxSourceLines: number): boolean {
  for (const [filePath, fileNodes] of groupByFile(nodes)) {
    const ranges = fileNodes
      .map((node) => readNodeSource(node, rootDir, maxSourceLines))
      .filter((range): range is SourceRange => range !== null);
    if (ranges.length === 0) continue;
    if (!emitter.offer({ type: "source", filePath, ranges })) return false;
  }
  return true;
}

function buildScopeSuggestions(nodes: GraphNode[], detail: DetailLevel): string[] {
  if (nodes.length === 0) return [];
  const suggestions: string[] = [];
  if (detail !== "source") suggestions.push(`mex graph get ${nodes[0]!.id} --detail source`);
  suggestions.push(`mex graph query who-calls ${nodes[0]!.name}`);
  return suggestions;
}

function factFor(session: AgentGraphSession, id: string, detail: DetailLevel, includeFingerprint: boolean): CompactFact | null {
  const fact = compactFact(session.graph, id, detail);
  if (!fact || !includeFingerprint) return fact;
  const fingerprint = new FingerprintStore(session.db).get(id);
  return fingerprint ? { ...fact, fingerprint: serializeFingerprint(fingerprint) } : fact;
}

function dedupeById(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function openSession(rootDir: string, deps: AgentCommandDeps, write: (line: string) => void): AgentGraphSession | null {
  try {
    if (deps.open) return deps.open(rootDir);
    const dbPath = resolve(rootDir, ".mex", "graph.db");
    if (!existsSync(dbPath)) {
      writeJson(write, { type: "error", code: "GRAPH_UNAVAILABLE", message: "Run `mex graph` first." });
      return null;
    }
    const graph = createGraphEngine({ rootDir, dbPath });
    const db = openSqlite(dbPath);
    return { graph, db, close: () => { graph.close(); db.close(); } };
  } catch (error) {
    unavailable(write, error);
    return null;
  }
}

function resolveSymbol(graph: GraphEngine, target: string): GraphNode[] {
  const exactId = graph.getNode(target);
  if (exactId) return [exactId];
  const matches = graph.searchNodes(target, { limit: 100 });
  const exact = matches.filter((node) => node.name === target || node.qualifiedName === target);
  return exact.length > 0 ? exact : matches;
}

function nodesForFile(session: AgentGraphSession, rootDir: string, target: string): GraphNode[] {
  const relativeTarget = (target.startsWith("/") ? relative(rootDir, target) : target)
    .replace(/^\.\//, "").replaceAll("\\", "/");
  const rows = session.db.prepare("SELECT id FROM nodes WHERE file_path = ? ORDER BY id").all(relativeTarget) as Array<{ id: string }>;
  return rows.map((row) => session.graph.getNode(row.id)).filter((node): node is GraphNode => node !== null);
}

function transitiveCallers(graph: GraphEngine, root: GraphNode, maxDepth: number): Array<{ node: GraphNode; depth: number }> {
  const seen = new Set([root.id]);
  const queue: Array<{ node: GraphNode; depth: number }> = [{ node: root, depth: 0 }];
  const results: Array<{ node: GraphNode; depth: number }> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const caller of graph.getCallers(current.node.id).sort(byId)) {
      if (seen.has(caller.id)) continue;
      seen.add(caller.id);
      const entry = { node: caller, depth: current.depth + 1 };
      results.push(entry);
      queue.push(entry);
    }
  }
  return results;
}

function groundedFiles(db: SqliteDatabase, nodeIds: string[]): Array<{ scaffold_file: string; node_id: string }> {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT scaffold_file, node_id FROM _mex_grounded_source WHERE node_id IN (${placeholders}) ORDER BY scaffold_file, node_id`,
  ).all(...nodeIds) as Array<{ scaffold_file: string; node_id: string }>;
}

function nodeRef(node: GraphNode): Record<string, string | number> {
  return { id: node.id, kind: node.kind, name: node.name, file: node.filePath, line: node.startLine };
}

function byId(left: GraphNode, right: GraphNode): number { return left.id.localeCompare(right.id); }
function isRelation(value: string): value is QueryRelation {
  return value === "who-calls" || value === "what-calls" || value === "where-defined";
}
function writeJson(write: (line: string) => void, value: unknown): void { write(JSON.stringify(value)); }
function unavailable(write: (line: string) => void, error: unknown): void {
  writeJson(write, {
    type: "error",
    code: "GRAPH_UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
  });
}
