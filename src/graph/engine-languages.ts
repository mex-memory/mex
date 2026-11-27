// Which languages the Rust graph engine (OSS-73) builds instead of today's
// extractors. Kept apart from native-engine.ts so the manifest, which graph
// reads load, can fold the choice in without loading the engine client.

import type { GraphEngineFallback } from "./engine.js";
import type { GraphEngineRuntime } from "../team/contracts/graph.js";
import type { Language } from "./types.js";

/** A comma-separated override for the engine's default language families. */
export const GRAPH_ENGINE_LANGUAGES_ENV = "MEX_GRAPH_ENGINE_LANGUAGES";
const ECMASCRIPT_FAMILIES = ["javascript", "typescript"] as const;
const ENGINE_LANGUAGES = ["csharp", "javascript", "python", "rust", "typescript"];
export const TREE_SITTER_EXTRACTOR_VERSION = "tree-sitter-v5";
/** Bumped when the engine's rows for a language change. */
const ENGINE_EXTRACTOR_VERSION = "v1";
const ENGINE_ECMASCRIPT_EXTRACTOR_VERSION = "v2";

export function graphEngineLanguages(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env[GRAPH_ENGINE_LANGUAGES_ENV];
  if (override === undefined) return [...ENGINE_LANGUAGES];
  const listed = override.split(",").map((name) => name.trim().toLowerCase());
  return ENGINE_LANGUAGES.filter((name) => listed.includes(name));
}

/** Schema v5 is used when the selected engine covers the whole corpus. */
export function graphStorageV5(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEX_GRAPH_STORAGE !== "v4";
}

/** Group JSX with JavaScript and TSX with TypeScript for engine selection. */
export function graphEngineLanguageFamily(language: Language): Language {
  if (language === "tsx") return "typescript";
  if (language === "jsx") return "javascript";
  return language;
}

export function graphEngineHandlesEcmaScript(languages: readonly string[]): boolean {
  return ECMASCRIPT_FAMILIES.some((language) => languages.includes(language));
}

export function isEcmaScriptLanguage(language: Language): boolean {
  const family = graphEngineLanguageFamily(language);
  return family === "javascript" || family === "typescript";
}

/** The suffix an extractor version gains while the engine builds `languages`; empty without any. */
export function engineExtractorSuffix(languages: readonly string[]): string {
  if (languages.length === 0) return "";
  const version = graphEngineHandlesEcmaScript(languages) ? ENGINE_ECMASCRIPT_EXTRACTOR_VERSION : ENGINE_EXTRACTOR_VERSION;
  return `+engine-${languages.join("-")}-${version}`;
}

export function engineFileExtractorVersion(language: Language): string {
  return TREE_SITTER_EXTRACTOR_VERSION + engineExtractorSuffix([graphEngineLanguageFamily(language)]);
}

export function graphEngineFallbackMessage(fallback: GraphEngineFallback): string {
  const files = `${fallback.fallbackFiles} file(s) (${fallback.languages.join(", ")})`;
  const reason = fallback.fellBack ?? "the engine skipped files or returned source hashes that differed from discovery";
  return `Rust graph engine not used for ${files}: ${reason}. Node's tree-sitter extractors processed those files.`;
}

export function graphEngineRuntimeLabel(runtime: GraphEngineRuntime): string {
  switch (runtime) {
    case "native": return "native (Rust)";
    case "wasi": return "WASI (Rust)";
    case "node": return "Node tree-sitter";
  }
}

/** Persisted fallback reasons contain only owned messages and bounded engine codes. */
export function isGraphEngineFallbackReason(reason: unknown): reason is string {
  return typeof reason === "string" && (
    [
      "no mex-graph binary was found",
      "the mex-graph binary could not be executed",
      "the WASI graph engine could not start",
      "mex-graph version did not identify a contract",
      "mex-graph version printed something that isn't JSON",
      "the engine job could not be started",
      "the engine did not report every requested file",
      "the engine did not produce a candidate",
      "the engine returned an incompatible candidate",
    ].includes(reason)
    || /^mex-graph version exited (?:-?\d+|SIG[A-Z0-9]+|null)$/u.test(reason)
    || /^the engine speaks contract -?\d+, MEX needs \d+$/u.test(reason)
    || /^the engine stopped \((?:graph_[a-z0-9_]{1,64}|exit \d+|SIG[A-Z0-9]+|missing or invalid result)\)$/u.test(reason)
  );
}
