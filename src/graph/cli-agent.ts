import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createGraphEngine } from "./engine-impl.js";
import type { GraphEngine } from "./engine.js";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import type { GraphNode } from "./types.js";
import { clusterFacts, scopeSelect, type NodeFacts } from "./scope.js";

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

/** Agent-facing blast radius. Output is newline-delimited JSON (JSONL). */
export function runImpact(target: string, rootDir = process.cwd(), deps: AgentCommandDeps = {}): void {
  const write = deps.write ?? console.log;
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

    writeJson(write, { type: "target", targetType: fileNodes.length > 0 ? "file" : "symbol", value: target });
    const impacted = new Map<string, { node: GraphNode; depth: number; root: string }>();
    for (const root of roots.sort(byId)) {
      writeJson(write, { type: "defines", ...hydrate(session.graph, root, rootDir) });
      for (const entry of transitiveCallers(session.graph, root)) {
        const current = impacted.get(entry.node.id);
        if (!current || entry.depth < current.depth) impacted.set(entry.node.id, { ...entry, root: root.id });
      }
    }
    for (const entry of [...impacted.values()].sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id))) {
      writeJson(write, { type: "caller", depth: entry.depth, root: entry.root, ...hydrate(session.graph, entry.node, rootDir) });
    }
    const affectedIds = [...new Set([...roots.map((node) => node.id), ...impacted.keys()])];
    for (const grounding of groundedFiles(session.db, affectedIds)) {
      writeJson(write, { type: "grounding", node: grounding.node_id, file: grounding.scaffold_file });
    }
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
): void {
  const write = deps.write ?? console.log;
  if (!isRelation(relation)) {
    writeJson(write, { type: "error", code: "INVALID_QUERY", relation, expected: ["who-calls", "what-calls", "where-defined"] });
    return;
  }
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const nodes = resolveSymbol(session.graph, target);
    if (nodes.length === 0) {
      writeJson(write, { type: "error", code: "TARGET_NOT_FOUND", target });
      return;
    }
    for (const node of nodes.sort(byId)) {
      if (relation === "where-defined") {
        writeJson(write, { type: "result", relation, target: node.id, ...hydrate(session.graph, node, rootDir) });
        continue;
      }
      const related = relation === "who-calls" ? session.graph.getCallers(node.id) : session.graph.getCallees(node.id);
      for (const result of related.sort(byId)) {
        writeJson(write, { type: "result", relation, target: node.id, ...hydrate(session.graph, result, rootDir) });
      }
    }
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Broad graph retrieval for an agent task. Output is hydrated JSONL. */
export function runGraphScope(task: string, rootDir = process.cwd(), deps: AgentCommandDeps = {}): void {
  const write = deps.write ?? console.log;
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const ids = scopeSelect(session.graph, task);
    for (const fact of clusterFacts(session.graph, ids, rootDir)) {
      writeJson(write, { type: "fact", ...fact });
    }
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
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

function transitiveCallers(graph: GraphEngine, root: GraphNode): Array<{ node: GraphNode; depth: number }> {
  const seen = new Set([root.id]);
  const queue: Array<{ node: GraphNode; depth: number }> = [{ node: root, depth: 0 }];
  const results: Array<{ node: GraphNode; depth: number }> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
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

function hydrate(graph: GraphEngine, node: GraphNode, rootDir: string): NodeFacts {
  return clusterFacts(graph, [node.id], rootDir)[0]!;
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
