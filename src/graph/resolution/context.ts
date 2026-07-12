import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphStore } from "../db/store.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "./types.js";

export function createResolutionContext(store: GraphStore, projectRoot: string): ResolutionContext {
  const nodes = (): GraphNode[] => store.getAllNodes();
  return {
    getNodesInFile: (path) => nodes().filter((node) => node.filePath === path),
    getNodesByName: (name) => nodes().filter((node) => node.name === name),
    getNodesByQualifiedName: (name) => nodes().filter((node) => node.qualifiedName === name),
    getNodesByKind: (kind) => nodes().filter((node) => node.kind === kind),
    getNodeById: (id) => store.getNodeById(id),
    fileExists: (path) => existsSync(resolve(projectRoot, path)),
    readFile: (path) => { try { return readFileSync(resolve(projectRoot, path), "utf-8"); } catch { return null; } },
    getProjectRoot: () => projectRoot,
    getAllFiles: () => [...new Set(nodes().map((node) => node.filePath))].sort(),
  };
}
