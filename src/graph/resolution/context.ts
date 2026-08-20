import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphStore } from "../db/store.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "./types.js";

export function createResolutionContext(store: GraphStore, projectRoot: string): ResolutionContext {
  // A resolution pass reads the node set many times over (framework resolvers
  // call getNodesByName once per unresolved ref). getAllNodes() runs a full
  // `SELECT * FROM nodes` + row-map every call, so hitting it per accessor is
  // O(N*R). Snapshot the nodes once — the context is a read-only view for the
  // duration of a single pass — and build indexes for the hot lookups.
  let nodes: GraphNode[] | null = null;
  let byName: Map<string, GraphNode[]> | null = null;
  let byFile: Map<string, GraphNode[]> | null = null;
  let byKind: Map<string, GraphNode[]> | null = null;
  let byQualifiedName: Map<string, GraphNode[]> | null = null;

  const allNodes = (): GraphNode[] => (nodes ??= store.getAllNodes());

  const index = (key: (node: GraphNode) => string): Map<string, GraphNode[]> => {
    const map = new Map<string, GraphNode[]>();
    for (const node of allNodes()) {
      const k = key(node);
      const bucket = map.get(k);
      if (bucket) bucket.push(node);
      else map.set(k, [node]);
    }
    return map;
  };

  return {
    getNodesInFile: (path) => (byFile ??= index((node) => node.filePath)).get(path) ?? [],
    getNodesByName: (name) => (byName ??= index((node) => node.name)).get(name) ?? [],
    getNodesByQualifiedName: (name) =>
      (byQualifiedName ??= index((node) => node.qualifiedName)).get(name) ?? [],
    getNodesByKind: (kind) => (byKind ??= index((node) => node.kind)).get(kind) ?? [],
    getNodeById: (id) => store.getNodeById(id),
    fileExists: (path) => existsSync(resolve(projectRoot, path)),
    readFile: (path) => { try { return readFileSync(resolve(projectRoot, path), "utf-8"); } catch { return null; } },
    getProjectRoot: () => projectRoot,
    getAllFiles: () => [...new Set(allNodes().map((node) => node.filePath))].sort(),
  };
}

/**
 * Read-only resolver view over a staged corpus. This is used before the publish
 * transaction so framework detection and cross-file resolution cannot hold the
 * WAL writer lock while reading/parsing project files.
 */
export function createStagedResolutionContext(
  stagedNodes: readonly GraphNode[],
  projectRoot: string,
  stagedSources: ReadonlyMap<string, string> = new Map(),
): ResolutionContext {
  const nodes = [...stagedNodes];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const index = (key: (node: GraphNode) => string): Map<string, GraphNode[]> => {
    const map = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      const value = key(node);
      const bucket = map.get(value) ?? [];
      bucket.push(node);
      map.set(value, bucket);
    }
    return map;
  };
  const byFile = index((node) => node.filePath);
  const byName = index((node) => node.name);
  const byQualifiedName = index((node) => node.qualifiedName);
  const byKind = index((node) => node.kind);
  return {
    getNodesInFile: (path) => byFile.get(path) ?? [],
    getNodesByName: (name) => byName.get(name) ?? [],
    getNodesByQualifiedName: (name) => byQualifiedName.get(name) ?? [],
    getNodesByKind: (kind) => byKind.get(kind) ?? [],
    getNodeById: (id) => byId.get(id) ?? null,
    fileExists: (path) => stagedSources.has(path) || existsSync(resolve(projectRoot, path)),
    readFile: (path) => stagedSources.get(path)
      ?? (() => { try { return readFileSync(resolve(projectRoot, path), "utf-8"); } catch { return null; } })(),
    getProjectRoot: () => projectRoot,
    getAllFiles: () => [...new Set([...stagedSources.keys(), ...nodes.map((node) => node.filePath)])].sort(),
  };
}
