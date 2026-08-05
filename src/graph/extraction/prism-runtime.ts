// ============================================================================
// mex code-graph — Prism (Ruby) parser runtime
// ============================================================================
//
// Ruby's own parser, not a tree-sitter grammar: `@ruby/prism` ships Ruby core's
// Prism parser as WASM, which is more semantically accurate for Ruby than the
// community tree-sitter-ruby grammar (it's the same parser CRuby 3.3+ uses).
// It has no relationship to web-tree-sitter's `Parser`/`Language`, so it can't
// live in `grammars.ts`'s tree-sitter loader — this module is Ruby's parallel,
// minimal loader: load the WASM once, cache the returned sync parse function.

import { loadPrism } from "@ruby/prism";

type PrismParseFn = Awaited<ReturnType<typeof loadPrism>>;
export type PrismParseResult = ReturnType<PrismParseFn>;

let parseFn: PrismParseFn | null = null;

/** Load the Prism WASM module. Idempotent. */
export async function loadPrismRuntime(): Promise<void> {
  if (parseFn) return;
  parseFn = await loadPrism();
}

/** Whether {@link loadPrismRuntime} has completed. */
export function isPrismLoaded(): boolean {
  return parseFn !== null;
}

/** Parse Ruby source, or null if the runtime was never loaded. */
export function parseRubySource(source: string): PrismParseResult | null {
  return parseFn ? parseFn(source) : null;
}

/** Reset the cached parser (tests / teardown, mirrors `disposeParsers`). */
export function disposePrismRuntime(): void {
  parseFn = null;
}
