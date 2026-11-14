import { rmSync, writeFileSync } from "node:fs";
import { currentGraphPath, graphLocation, graphPointerFile, graphTemporary, publishGraph, verifiedGraphLocation } from "../storage.js";

/**
 * Publish arbitrary bytes (or a database written by `write`) as the checkout's
 * current graph, through the real pointer, so tests can plant corrupt or
 * hand-made graphs where 0.8 tests wrote `.mex/graph.db`.
 */
export function plantGraph(root: string, contents: string | Buffer | ((file: string) => void)): string {
  const location = verifiedGraphLocation(root);
  const temporary = graphTemporary(location);
  if (typeof contents === "function") contents(temporary); else writeFileSync(temporary, contents);
  publishGraph(location, temporary, { head: null, files: 0, nodes: 0, edges: 0, build: {} });
  return currentGraphPath(root);
}

/** Forget the checkout's published graph (0.8 tests deleted `.mex/graph.db`); the next build starts cold. */
export function removeGraph(root: string): void {
  const location = graphLocation(root);
  rmSync(graphPointerFile(location), { force: true });
}
