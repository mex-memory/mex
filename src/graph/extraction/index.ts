// ============================================================================
// mex code-graph — single-file extraction entry point
// ============================================================================
//
// Ties the grammar loader (A5) to the language extractors (A1): parse a file
// with its grammar, then run the registered `LanguageExtractor` over the tree.
// Grammars must already be loaded (`loadGrammars` — the engine batches that up
// front for the languages it finds). Pure and deterministic per file.

import type { Language } from "../types.js";
import type { ExtractedEdge, ExtractedNode } from "./types.js";
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
