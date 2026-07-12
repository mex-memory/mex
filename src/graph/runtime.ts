import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "glob";
import type { MexConfig, Grounding } from "../types.js";
import { extractGroundings, findMexAnchors, rewriteMexAnchor, writeGroundings } from "../markdown.js";
import { createGroundingChecker, type GroundingChecker, type GroundedSource } from "./grounding.js";
import { createGraphEngine } from "./engine-impl.js";
import type { GraphEngine } from "./engine.js";
import { openGraphDatabase } from "./db/database.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { deserializeFingerprint, serializeFingerprint } from "./fingerprint.js";
import { MinHashReconciler } from "./reconcile-engine.js";
import type { Fingerprint, Reconciler } from "./reconcile.js";

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}";
const SOURCE_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.mex/**", "**/coverage/**", "**/.next/**", "**/out/**"];

export interface GroundingRuntime {
  graph: GraphEngine;
  reconciler: MinHashReconciler;
  checker: GroundingChecker;
  fingerprints: FingerprintStore;
  /** Pre-sync fingerprints for inline ids that may disappear during a rename. */
  anchorFingerprints: ReadonlyMap<string, Fingerprint>;
  close(): void;
}

export async function loadGroundingRuntime(config: MexConfig): Promise<GroundingRuntime | null> {
  const dbPath = resolve(config.projectRoot, ".mex", "graph.db");
  if (!existsSync(dbPath)) return null;
  const graph = createGraphEngine({ rootDir: config.projectRoot, dbPath });
  let db: SqliteDatabase | null = null;
  try {
    db = openGraphDatabase(dbPath);
    const fingerprints = new FingerprintStore(db);
    const anchorFingerprints = snapshotAnchorFingerprints(config, fingerprints);
    const changed = findChangedSourceFiles(config.projectRoot, db);
    if (changed.length > 0) await graph.sync(changed);
    const reconciler = new MinHashReconciler(fingerprints);
    const checkerReconciler: Reconciler & GroundingReconcilerCapabilities = {
      reconcile: (nodeId, baseline) => reconciler.reconcile(nodeId, baseline),
      getFingerprint: (nodeId) => anchorFingerprints.get(nodeId) ?? reconciler.getFingerprint(nodeId),
      getGroundedSource: (file, nodeId) => reconciler.getGroundedSource(file, nodeId),
    };
    return {
      graph,
      reconciler,
      checker: createGroundingChecker(graph, checkerReconciler),
      fingerprints,
      anchorFingerprints,
      close: () => { graph.close(); db?.close(); db = null; },
    };
  } catch (error) {
    graph.close();
    db?.close();
    throw error;
  }
}

/** Compare graph file metadata to disk; includes additions, edits, and deletions. */
export function findChangedSourceFiles(projectRoot: string, db: SqliteDatabase): string[] {
  const rows = db.prepare("SELECT path, size, modified_at FROM files").all() as Array<{
    path: string; size: number; modified_at: number;
  }>;
  const tracked = new Map(rows.map((row) => [row.path, row]));
  const current = globSync(SOURCE_GLOB, { cwd: projectRoot, ignore: SOURCE_IGNORE, nodir: true })
    .map((path) => path.replaceAll("\\", "/"));
  const changed: string[] = [];
  for (const path of current) {
    const row = tracked.get(path);
    const stat = statSync(resolve(projectRoot, path));
    if (!row || row.size !== stat.size || row.modified_at !== stat.mtimeMs) changed.push(path);
    tracked.delete(path);
  }
  changed.push(...tracked.keys());
  return [...new Set(changed)].sort();
}

/** Persist only high-confidence MOVED repairs. AMBIGUOUS/GONE remain for the agent. */
export function persistMovedGroundings(
  config: MexConfig,
  scaffoldFiles: readonly string[],
  runtime: GroundingRuntime,
): number {
  let moved = 0;
  for (const filePath of scaffoldFiles) {
    const content = readFileSync(filePath, "utf-8");
    const groundings = extractGroundings(content);
    const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
    let dirty = false;
    for (const grounding of groundings) {
      if (runtime.graph.getNode(grounding.node)) continue;
      const baselineSource = runtime.reconciler.getGroundedSource(scaffoldFile, grounding.node);
      const baseline = deserializeFingerprint(grounding.fingerprint)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const resolution = runtime.reconciler.reconcile(grounding.node, baseline);
      if (resolution.kind !== "MOVED") continue;
      const oldId = grounding.node;
      grounding.node = resolution.nodeId;
      const fingerprint = runtime.reconciler.getFingerprint(resolution.nodeId);
      if (fingerprint) grounding.fingerprint = serializeFingerprint(fingerprint);
      saveCurrentBaseline(config, scaffoldFile, grounding, runtime);
      runtime.fingerprints.deleteGroundedSource(scaffoldFile, oldId);
      dirty = true;
      moved += 1;
    }
    const groundedContent = dirty ? writeGroundings(content, groundings) : content;
    let anchoredContent = groundedContent;
    const anchors = findMexAnchors(anchoredContent);
    for (const anchor of [...anchors].reverse()) {
      if (runtime.graph.getNode(anchor.nodeId)) continue;
      const baselineSource = runtime.reconciler.getGroundedSource(scaffoldFile, anchor.nodeId);
      const baseline = runtime.anchorFingerprints.get(anchor.nodeId)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const resolution = runtime.reconciler.reconcile(anchor.nodeId, baseline);
      if (resolution.kind !== "MOVED") continue;
      anchoredContent = rewriteMexAnchor(anchoredContent, anchor, resolution.nodeId);
      moved += 1;
    }
    if (anchoredContent !== content) writeFileSync(filePath, anchoredContent, "utf-8");
  }
  return moved;
}

interface GroundingReconcilerCapabilities {
  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getFingerprint(nodeId: string): Fingerprint | null;
}

function snapshotAnchorFingerprints(config: MexConfig, store: FingerprintStore): Map<string, Fingerprint> {
  const snapshots = new Map<string, Fingerprint>();
  const files = [
    ...globSync("**/*.md", { cwd: config.scaffoldRoot, absolute: true, nodir: true }),
    ...["CLAUDE.md", ".cursorrules", ".windsurfrules"]
      .map((file) => resolve(config.projectRoot, file))
      .filter(existsSync),
  ];
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf-8"); } catch { continue; }
    for (const anchor of findMexAnchors(content)) {
      const fingerprint = store.get(anchor.nodeId);
      if (fingerprint) snapshots.set(anchor.nodeId, fingerprint);
    }
  }
  return snapshots;
}

/** Close the sync loop after an agent pass by refreshing ids' fingerprints and snapshots. */
export function refreshGroundingBaselines(
  config: MexConfig,
  scaffoldFiles: readonly string[],
  runtime: GroundingRuntime,
): void {
  for (const filePath of scaffoldFiles) {
    const content = readFileSync(filePath, "utf-8");
    const groundings = extractGroundings(content);
    if (groundings.length === 0) continue;
    const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
    let dirty = false;
    for (const grounding of groundings) {
      const fingerprint = runtime.reconciler.getFingerprint(grounding.node);
      if (!fingerprint || !runtime.graph.getNode(grounding.node)) continue;
      const serialized = serializeFingerprint(fingerprint);
      if (grounding.fingerprint !== serialized) { grounding.fingerprint = serialized; dirty = true; }
      saveCurrentBaseline(config, scaffoldFile, grounding, runtime);
    }
    if (dirty) writeFileSync(filePath, writeGroundings(content, groundings), "utf-8");
  }
}

export function groundingPromptContext(
  config: MexConfig,
  scaffoldFile: string,
  nodeId: string,
  runtime: GroundingRuntime,
  candidateId?: string,
): { nodeId: string; oldBody: string; newBody: string; candidateId?: string } | null {
  const baseline = runtime.reconciler.getGroundedSource(scaffoldFile, nodeId);
  const current = runtime.graph.getNode(candidateId ?? nodeId);
  if (!baseline || !current) return null;
  return {
    nodeId,
    oldBody: baseline.source,
    newBody: readNodeBody(config.projectRoot, current.filePath, current.startLine, current.endLine),
    candidateId,
  };
}

function saveCurrentBaseline(config: MexConfig, scaffoldFile: string, grounding: Grounding, runtime: GroundingRuntime): void {
  const node = runtime.graph.getNode(grounding.node);
  if (!node?.bodyHash) return;
  const source: GroundedSource = {
    scaffoldFile,
    nodeId: node.id,
    source: readNodeBody(config.projectRoot, node.filePath, node.startLine, node.endLine),
    bodyHash: node.bodyHash,
    fingerprint: grounding.fingerprint,
  };
  runtime.fingerprints.saveGroundedSource(source);
}

function readNodeBody(root: string, filePath: string, startLine: number, endLine: number): string {
  return readFileSync(resolve(root, filePath), "utf-8").split("\n").slice(startLine - 1, endLine).join("\n");
}
