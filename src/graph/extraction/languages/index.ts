// ============================================================================
// mex code-graph — extractor registry
// ============================================================================
//
// The single place a language id maps to its `LanguageExtractor`. 0.7.0 wires
// TS/JS/TSX/JSX only (spec §2 — ship the framework's multi-language SHAPE, but
// only the TS/JS extractor). A 0.7.x contributor adds a language by importing
// their extractor and adding one line here.

import type { Language } from "../../types.js";
import type { LanguageExtractor } from "../types.js";
import { typescriptExtractor, tsxExtractor } from "./typescript.js";
import { javascriptExtractor, jsxExtractor } from "./javascript.js";
import { pythonExtractor } from "./python.js";

/** Registered extractors, keyed by the language id they emit. */
export const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = {
  typescript: typescriptExtractor,
  tsx: tsxExtractor,
  javascript: javascriptExtractor,
  jsx: jsxExtractor,
  python: pythonExtractor,
};

/** The extractor for a language, or undefined if unsupported in this release. */
export function getExtractor(language: Language): LanguageExtractor | undefined {
  return EXTRACTORS[language];
}
