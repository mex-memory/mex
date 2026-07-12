// ============================================================================
// mex code-graph — cross-file reference resolution  (A4)
// ============================================================================
//
// Extractors emit references UNRESOLVED (a `targetName` symbol, never a node id)
// because a name in one file may bind to a symbol in ANOTHER. After the whole
// project is indexed, this pass binds each reference to a concrete node and
// produces the persisted reference edges (calls / imports / extends / …).
//
// This is the 0.7.0 BASE resolver: name-based, with import-awareness for
// disambiguation. It deliberately ships NO framework resolvers — the frozen
// `FrameworkResolver` seam (`./types.ts`) is where the 0.7.x community adds
// framework-specific edges. Kept pure (nodes + refs in → edges out) so it is
// trivially unit-testable and reused unchanged by both `build` and `sync`.

import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from "../types.js";
import type { UnresolvedRefRecord } from "../db/store.js";
import type { FrameworkResolver, ResolutionContext } from "./types.js";

/** Module-file extensions tried when resolving a relative import specifier. */
const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Node kinds a reference of a given kind is allowed to bind to. */
const TARGET_KINDS: Record<string, NodeKind[]> = {
  calls: ["function", "method"],
  extends: ["class", "interface"],
  implements: ["interface", "class"],
  instantiates: ["class"],
  references: [], // any kind
  function_ref: ["function", "method"],
};

/**
 * Resolve every unresolved reference against the full node set. Returns the
 * reference edges to persist (`contains` edges are already resolved by the
 * extractor and are not touched here).
 */
export function resolveReferences(
  nodes: GraphNode[],
  refs: UnresolvedRefRecord[],
  framework: { resolvers: readonly FrameworkResolver[]; context: ResolutionContext } | null = null,
): GraphEdge[] {
  const byId = new Map<string, GraphNode>();
  const byName = new Map<string, GraphNode[]>();
  const fileNodeByPath = new Map<string, string>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (node.kind === "file") {
      fileNodeByPath.set(node.filePath, node.id);
    } else {
      const list = byName.get(node.name);
      if (list) list.push(node);
      else byName.set(node.name, [node]);
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>(); // dedup (source|target|kind)
  const importsByFile = new Map<string, Set<string>>(); // file → imported file paths

  const push = (
    source: string,
    target: string,
    kind: EdgeKind,
    ref: UnresolvedRefRecord,
    provenance: GraphEdge["provenance"] = "tree-sitter",
  ) => {
    const key = `${source}|${target}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      source,
      target,
      kind,
      line: ref.line,
      column: ref.column,
      provenance,
    });
  };

  // Pass 1: imports. Resolve each specifier to the imported file's `file:` node,
  // and record file→file import relationships for the call-resolution preference.
  for (const ref of refs) {
    if (ref.referenceKind !== "imports") continue;
    const fromNode = byId.get(ref.fromNodeId);
    if (!fromNode) continue;

    const targetPath = resolveModulePath(fromNode.filePath, ref.referenceName, fileNodeByPath);
    if (!targetPath) continue;
    const targetFileId = fileNodeByPath.get(targetPath);
    if (!targetFileId) continue;
    push(ref.fromNodeId, targetFileId, "imports", ref);
    let set = importsByFile.get(fromNode.filePath);
    if (!set) importsByFile.set(fromNode.filePath, (set = new Set()));
    set.add(targetPath);
  }

  // Pass 2: symbol references (calls, extends, implements, instantiates, …).
  for (const ref of refs) {
    if (ref.referenceKind === "imports") continue;
    const fromNode = byId.get(ref.fromNodeId);
    if (!fromNode) continue;

    const frameworkResolution = framework?.resolvers
      .filter((resolver) => !resolver.languages || resolver.languages.includes(ref.language))
      .map((resolver) => resolver.resolve(ref, framework.context))
      .find((result) => result !== null);
    if (frameworkResolution) {
      const kind = ref.referenceKind === "function_ref"
        ? "references"
        : ref.referenceKind as EdgeKind;
      push(ref.fromNodeId, frameworkResolution.targetNodeId, kind, ref, "heuristic");
      continue;
    }

    // A `recv.method` callee resolves on its method name (last segment).
    const simpleName = lastSegment(ref.referenceName);
    const candidates = byName.get(simpleName);
    if (!candidates || candidates.length === 0) continue;

    const allowedKinds = TARGET_KINDS[ref.referenceKind] ?? [];
    const filtered =
      allowedKinds.length === 0
        ? candidates.filter((n) => n.id !== ref.fromNodeId)
        : candidates.filter((n) => allowedKinds.includes(n.kind) && n.id !== ref.fromNodeId);
    if (filtered.length === 0) continue;

    const target = pickBest(filtered, fromNode.filePath, importsByFile.get(fromNode.filePath));
    if (!target) continue;

    const edgeKind: EdgeKind =
      ref.referenceKind === "function_ref" ? "references" : (ref.referenceKind as EdgeKind);
    push(ref.fromNodeId, target.id, edgeKind, ref);
  }

  return edges;
}

/**
 * Choose the best target among same-named candidates:
 *   1. one defined in the SAME file as the reference,
 *   2. one in a file the reference's file IMPORTS,
 *   3. the sole candidate, or a unique exported candidate,
 *   otherwise null (ambiguous — better no edge than a wrong one).
 */
function pickBest(
  candidates: GraphNode[],
  fromFile: string,
  importedFiles: Set<string> | undefined,
): GraphNode | null {
  const sameFile = candidates.find((n) => n.filePath === fromFile);
  if (sameFile) return sameFile;

  if (importedFiles) {
    const imported = candidates.filter((n) => importedFiles.has(n.filePath));
    if (imported.length === 1) return imported[0]!;
    if (imported.length > 1) {
      const exported = imported.filter((n) => n.isExported);
      if (exported.length === 1) return exported[0]!;
    }
  }

  if (candidates.length === 1) return candidates[0]!;
  const exported = candidates.filter((n) => n.isExported);
  if (exported.length === 1) return exported[0]!;
  return null;
}

/** The segment after the last `.` (`obj.method` → `method`; `free` → `free`). */
function lastSegment(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(dot + 1);
}

/**
 * Resolve a relative module specifier to a project file path that has a `file:`
 * node. Tries the bare path, each source extension, and an `index.*` under it.
 * Bare (non-relative) specifiers are external packages — unresolved (null).
 */
function resolveModulePath(
  fromFile: string,
  specifier: string,
  fileNodeByPath: Map<string, string>,
): string | null {
  if (!specifier.startsWith(".")) return null; // external package
  const base = posixJoin(posixDirname(fromFile), specifier);
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((ext) => base + ext),
    ...MODULE_EXTENSIONS.map((ext) => posixJoin(base, "index") + ext),
  ];
  for (const candidate of candidates) {
    if (fileNodeByPath.has(candidate)) return candidate;
  }
  return null;
}

// --- Minimal posix path helpers (graph paths are always forward-slash) -------

function posixDirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}

/** Join + normalize forward-slash path segments, collapsing `.` and `..`. */
function posixJoin(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}
