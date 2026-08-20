// ============================================================================
// mex code-graph — single-file extraction entry point
// ============================================================================
//
// Ties the grammar loader (A5) to the language extractors (A1): parse a file
// with its grammar, then run the registered `LanguageExtractor` over the tree.
// Grammars must already be loaded (`loadGrammars` — the engine batches that up
// front for the languages it finds). Pure and deterministic per file.

import type { Language } from "../types.js";
import type { ExtractedEdge, ExtractedNode, TSNode } from "./types.js";
import { detectLanguage, parse } from "./grammars.js";
import { getExtractor } from "./languages/index.js";

export {
  detectLanguage,
  isSupportedSourceFile,
  loadGrammars,
  supportedLanguages,
  disposeParsers,
  grammarManifestHash,
  SUPPORTED_SOURCE_GLOB,
} from "./grammars.js";
export { getExtractor, EXTRACTORS } from "./languages/index.js";
export { canonicalNodeIdentity, generateNodeId } from "./node-id.js";
export {
  buildTypeScriptExtraction,
  canonicalCompilerIdentity,
  discoverTypeScriptProjects,
  generateCanonicalCompilerNodeId,
  normalizedCompilerTokens,
  TYPESCRIPT_COMPILER_EXTRACTOR_VERSION,
  TYPESCRIPT_COMPILER_VERSION,
} from "./compiler.js";
export type {
  CompilerDiagnosticSummary,
  CompilerExtractedNode,
  CompilerExtractionOptions,
  CompilerExtractionResult,
  CompilerFileExtraction,
  CompilerImportBinding,
  CompilerNodeKind,
  CompilerParseStatus,
  CompilerReference,
  CompilerReferenceKind,
  CompilerResolutionStatus,
  CompilerSourceHealth,
  CompilerSourceLanguage,
  DiscoveredTypeScriptProject,
} from "./compiler.js";

/** What one file's extraction yields, before the engine resolves/persists it. */
export interface FileExtraction {
  language: Language;
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  health: {
    status: "ok" | "partial" | "failed";
    diagnosticCount: number;
    missingCount: number;
    errorCoverage: number;
    diagnostics: Array<{ type: string; startLine: number; endLine: number }>;
  };
}

/**
 * Parse + extract one file. Returns null when the language is unsupported or its
 * grammar was not loaded (caller records the file but graphs no symbols — spec
 * §7 graceful degradation). `language` defaults to detection from `filePath`.
 */
export function extractFile(
  filePath: string,
  source: string,
  language: Language = detectLanguage(filePath),
): FileExtraction | null {
  const extractor = getExtractor(language);
  if (!extractor) return null;
  const tree = parse(source, language);
  if (!tree) return null;
  const health = treeHealth(tree.rootNode, source);
  if (health.status === "failed") return { language, nodes: [], edges: [], health };
  const extracted = extractor.extract(tree, filePath, source);
  if (health.status === "partial" && extracted.nodes.every((node) => node.kind === "file")) {
    return { language, nodes: [], edges: [], health: { ...health, status: "failed" } };
  }
  const excluded = new Set(extracted.nodes.filter((node) => node.kind !== "file" && health.diagnostics.some((diagnostic) =>
    diagnostic.startLine <= node.endLine && diagnostic.endLine >= node.startLine,
  )).map((node) => node.id));
  const nodes = extracted.nodes.filter((node) => !excluded.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = extracted.edges.filter((edge) => nodeIds.has(edge.source) && (!edge.target || nodeIds.has(edge.target)));
  return { language, nodes, edges, health };
}

function treeHealth(root: TSNode, source: string): FileExtraction["health"] {
  const errors: TSNode[] = [];
  const missing: TSNode[] = [];
  let missingCount = 0;
  const visit = (node: TSNode): void => {
    if (node.type === "ERROR" || node.isError) errors.push(node);
    if (node.isMissing) {
      missingCount++;
      missing.push(node);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  const issueNodes = [...errors, ...missing];
  const ranges = issueNodes.map((node) => ({ start: node.startIndex, end: Math.max(node.startIndex + 1, node.endIndex) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end);
    else merged.push({ ...range });
  }
  const covered = merged.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0);
  const coverage = Math.min(1, covered / Math.max(1, Buffer.byteLength(source, "utf8")));
  const failed = root.type === "ERROR" || Boolean(root.isError) || coverage > 0.25;
  return {
    status: failed ? "failed" : errors.length > 0 || missingCount > 0 ? "partial" : "ok",
    diagnosticCount: errors.length,
    missingCount,
    errorCoverage: coverage,
    diagnostics: issueNodes.slice(0, 100).map((node) => ({
      type: node.isMissing ? `MISSING:${node.type}` : node.type,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })),
  };
}

/**
 * Return normalized AST leaf kinds for body-bearing node ranges. Identifier and
 * literal spellings are intentionally represented by grammar kinds, making the
 * Tier-2 fingerprint resilient to renames while retaining structural syntax.
 */
export function normalizedAstTokens(
  filePath: string,
  source: string,
  ranges: ReadonlyArray<{ id: string; startLine: number; endLine: number }>,
): Map<string, string[]> {
  const tree = parse(source, detectLanguage(filePath));
  if (!tree) return new Map();
  const leaves: Array<{ line: number; endLine: number; type: string }> = [];
  const visit = (node: TSNode): void => {
    if (node.childCount === 0) {
      leaves.push({ line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, type: node.type });
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNode);
  return new Map(ranges.map((range) => [
    range.id,
    leaves
      .filter((leaf) => leaf.line >= range.startLine && leaf.endLine <= range.endLine)
      .map((leaf) => leaf.type),
  ]));
}
