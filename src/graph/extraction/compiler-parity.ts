// Edge-by-edge comparison of two TypeScript extractions of the same corpus,
// for example the in-process 5.9 compiler against TypeScript 7.1's API. It is
// the parity harness for switching compilers: nodes are matched by what they
// declare (file, kind, qualified name, role and position among namesakes),
// never by printed types, so two compilers that print a type differently
// still match.

import type { CompilerExtractionResult, CompilerReference } from "./compiler.js";

export interface ParityDifference {
  key: string;
  detail?: string;
}

export interface CompilerParityReport {
  nodes: { left: number; right: number; matched: number; onlyLeft: ParityDifference[]; onlyRight: ParityDifference[] };
  /** Matched nodes whose structural fields differ (lines, columns, export, async, static, abstract, container). */
  nodeFieldDifferences: ParityDifference[];
  /** Matched nodes whose display text differs: signature, return type or docstring. Counted, not failures. */
  displayDifferences: { signature: number; returnType: number; docstring: number };
  edges: { left: number; right: number; matched: number; onlyLeft: ParityDifference[]; onlyRight: ParityDifference[] };
  /** Unresolved and ambiguous references by kind and status, per side. */
  unresolved: { left: Record<string, number>; right: Record<string, number> };
  imports: { left: number; right: number; differences: ParityDifference[] };
}

const STRUCTURAL_FIELDS = [
  "startLine", "endLine", "startColumn", "endColumn", "isExported", "isAsync", "isStatic", "isAbstract", "visibility",
] as const;

/** Compare two extractions. `limit` caps each list of differences; counts are always exact. */
export function compareCompilerExtractions(
  left: CompilerExtractionResult,
  right: CompilerExtractionResult,
  limit = 200,
): CompilerParityReport {
  const leftNodes = nodeKeys(left);
  const rightNodes = nodeKeys(right);
  const report: CompilerParityReport = {
    nodes: { left: leftNodes.byKey.size, right: rightNodes.byKey.size, matched: 0, onlyLeft: [], onlyRight: [] },
    nodeFieldDifferences: [],
    displayDifferences: { signature: 0, returnType: 0, docstring: 0 },
    edges: { left: 0, right: 0, matched: 0, onlyLeft: [], onlyRight: [] },
    unresolved: { left: {}, right: {} },
    imports: { left: 0, right: 0, differences: [] },
  };
  const push = (list: ParityDifference[], entry: ParityDifference): void => {
    if (list.length < limit) list.push(entry);
  };
  let onlyLeftNodes = 0;
  let onlyRightNodes = 0;
  for (const [key, node] of leftNodes.byKey) {
    const other = rightNodes.byKey.get(key);
    if (!other) {
      onlyLeftNodes++;
      push(report.nodes.onlyLeft, { key });
      continue;
    }
    report.nodes.matched++;
    for (const field of STRUCTURAL_FIELDS) {
      if ((node[field] ?? null) !== (other[field] ?? null)) {
        push(report.nodeFieldDifferences, { key, detail: `${field}: ${String(node[field])} → ${String(other[field])}` });
      }
    }
    const container = (id: string | undefined, keys: Map<string, string>): string | undefined => id ? keys.get(id) : undefined;
    if (container(node.containerId, leftNodes.keyById) !== container(other.containerId, rightNodes.keyById)) {
      push(report.nodeFieldDifferences, { key, detail: "container" });
    }
    if ((node.signature ?? "") !== (other.signature ?? "")) report.displayDifferences.signature++;
    if ((node.returnType ?? "") !== (other.returnType ?? "")) report.displayDifferences.returnType++;
    if ((node.docstring ?? "") !== (other.docstring ?? "")) report.displayDifferences.docstring++;
  }
  for (const key of rightNodes.byKey.keys()) {
    if (!leftNodes.byKey.has(key)) {
      onlyRightNodes++;
      push(report.nodes.onlyRight, { key });
    }
  }
  void onlyLeftNodes;
  void onlyRightNodes;

  const leftEdges = edgeKeys(left, leftNodes.keyById, report.unresolved.left);
  const rightEdges = edgeKeys(right, rightNodes.keyById, report.unresolved.right);
  report.edges.left = leftEdges.size;
  report.edges.right = rightEdges.size;
  for (const key of leftEdges) {
    if (rightEdges.has(key)) report.edges.matched++;
    else push(report.edges.onlyLeft, { key });
  }
  for (const key of rightEdges) if (!leftEdges.has(key)) push(report.edges.onlyRight, { key });

  const leftImports = importKeys(left, leftNodes.keyById);
  const rightImports = importKeys(right, rightNodes.keyById);
  report.imports.left = leftImports.size;
  report.imports.right = rightImports.size;
  for (const [key, value] of leftImports) {
    const other = rightImports.get(key);
    if (other !== value) push(report.imports.differences, { key, detail: `${value} → ${other ?? "(missing)"}` });
  }
  for (const key of rightImports.keys()) {
    if (!leftImports.has(key)) push(report.imports.differences, { key, detail: "(missing) → present" });
  }
  return report;
}

/** True when the two extractions agree on every node, edge and import. */
export function parityHolds(report: CompilerParityReport): boolean {
  return report.nodes.onlyLeft.length === 0 && report.nodes.onlyRight.length === 0
    && report.nodeFieldDifferences.length === 0
    && report.edges.onlyLeft.length === 0 && report.edges.onlyRight.length === 0
    && report.imports.differences.length === 0;
}

type ResultNode = CompilerExtractionResult["files"][number]["nodes"][number];

function nodeKeys(result: CompilerExtractionResult): { byKey: Map<string, ResultNode>; keyById: Map<string, string> } {
  const byKey = new Map<string, ResultNode>();
  const keyById = new Map<string, string>();
  for (const file of result.files) {
    const groups = new Map<string, ResultNode[]>();
    for (const node of file.nodes) {
      const base = [node.filePath, node.kind, node.qualifiedName, node.declarationRole].join("|");
      const group = groups.get(base) ?? [];
      group.push(node);
      groups.set(base, group);
    }
    for (const [base, group] of groups) {
      group.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn);
      group.forEach((node, index) => {
        const key = group.length === 1 ? base : `${base}#${index}`;
        byKey.set(key, node);
        keyById.set(node.id, key);
      });
    }
  }
  return { byKey, keyById };
}

function edgeKeys(
  result: CompilerExtractionResult,
  keyById: Map<string, string>,
  unresolved: Record<string, number>,
): Set<string> {
  const keys = new Set<string>();
  for (const file of result.files) {
    for (const reference of file.references) {
      if (reference.status !== "resolved" || !reference.targetId) {
        const bucket = `${reference.kind}:${reference.status}`;
        unresolved[bucket] = (unresolved[bucket] ?? 0) + 1;
        continue;
      }
      keys.add(edgeKey(reference, keyById));
    }
  }
  return keys;
}

function edgeKey(reference: CompilerReference, keyById: Map<string, string>): string {
  const source = keyById.get(reference.sourceId) ?? `?${reference.sourceId}`;
  const target = keyById.get(reference.targetId!) ?? `?${reference.targetId}`;
  return `${source} -${reference.kind}-> ${target} @${reference.filePath}:${reference.line + 1}:${reference.column}`;
}

function importKeys(result: CompilerExtractionResult, keyById: Map<string, string>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of result.files) {
    for (const binding of file.importBindings) {
      keys.set(
        `${binding.filePath}|${binding.localName}|${binding.moduleSpecifier}|${binding.importedName}`,
        `${binding.resolvedFilePath ?? "-"}|${binding.targetId ? keyById.get(binding.targetId) ?? "?" : "-"}|${binding.isTypeOnly}`,
      );
    }
  }
  return keys;
}
