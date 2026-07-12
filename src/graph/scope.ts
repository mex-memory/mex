import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphEngine } from "./engine.js";
import type { NodeKind } from "./types.js";

/** Ephemeral, agent-facing facts for one graph node. Never persisted. */
export interface NodeFacts {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  signature?: string;
  docstring?: string;
  returnType?: string;
  callers: string[];
  callees: string[];
  source: string;
}

/** FTS top-ten seeds expanded by one hop in both call directions. */
export function scopeSelect(graph: GraphEngine, task: string): string[] {
  const ids = new Set<string>();
  for (const seed of graph.searchNodes(task, { limit: 10 })) {
    ids.add(seed.id);
    for (const caller of graph.getCallers(seed.id)) ids.add(caller.id);
    for (const callee of graph.getCallees(seed.id)) ids.add(callee.id);
  }
  return [...ids];
}

/** Hydrate node ids with structural context and their current source bodies. */
export function clusterFacts(graph: GraphEngine, ids: string[], rootDir = process.cwd()): NodeFacts[] {
  const sourceFiles = new Map<string, string[] | null>();
  const facts: NodeFacts[] = [];
  for (const id of ids) {
    const node = graph.getNode(id);
    if (!node) continue;
    let lines = sourceFiles.get(node.filePath);
    if (lines === undefined) {
      try {
        lines = readFileSync(resolve(rootDir, node.filePath), "utf-8").split("\n");
      } catch {
        lines = null;
      }
      sourceFiles.set(node.filePath, lines);
    }
    facts.push({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      signature: node.signature,
      docstring: node.docstring,
      returnType: node.returnType,
      callers: graph.getCallers(id).map((entry) => entry.id),
      callees: graph.getCallees(id).map((entry) => entry.id),
      source: lines ? lines.slice(node.startLine - 1, node.endLine).join("\n") : "",
    });
  }
  return facts;
}
