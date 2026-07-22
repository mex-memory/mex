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

export { detectLanguage, isSupportedSourceFile, loadGrammars, supportedLanguages, disposeParsers } from "./grammars.js";
export { getExtractor, EXTRACTORS } from "./languages/index.js";
export { generateNodeId } from "./node-id.js";

/** What one file's extraction yields, before the engine resolves/persists it. */
export interface FileExtraction {
  language: Language;
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
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
  const { nodes, edges } = extractor.extract(tree, filePath, source);
  return { language, nodes, edges };
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
