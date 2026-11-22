// Which languages the Rust graph engine (OSS-73) builds instead of today's
// extractors. Kept apart from native-engine.ts so the manifest, which graph
// reads load, can fold the choice in without loading the engine client.

import type { Language } from "./types.js";

/** Languages the engine builds instead of today's extractors, e.g. `python`. */
export const GRAPH_ENGINE_LANGUAGES_ENV = "MEX_GRAPH_ENGINE_LANGUAGES";
/** Languages the engine can take over today. */
const ENGINE_LANGUAGES = new Set(["python", "typescript", "javascript"]);
/** Bumped when the engine's rows for a language change. */
const ENGINE_EXTRACTOR_VERSION = "v1";

/** The languages `MEX_GRAPH_ENGINE_LANGUAGES` hands to the engine (unknown names ignored), sorted. */
export function graphEngineLanguages(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env[GRAPH_ENGINE_LANGUAGES_ENV] ?? "").split(",").map((name) => name.trim().toLowerCase());
  return [...new Set(listed.filter((name) => ENGINE_LANGUAGES.has(name)))].sort();
}

/** The flag groups JSX with JavaScript, and TSX with TypeScript. */
export function graphEngineLanguageFamily(language: Language): Language {
  if (language === "tsx") return "typescript";
  if (language === "jsx") return "javascript";
  return language;
}

export function graphEngineHandlesEcmaScript(languages: readonly string[]): boolean {
  return languages.includes("typescript") || languages.includes("javascript");
}

/** The suffix an extractor version gains while the engine builds `languages`; empty without any. */
export function engineExtractorSuffix(languages: readonly string[]): string {
  return languages.length > 0 ? `+engine-${languages.join("-")}-${ENGINE_EXTRACTOR_VERSION}` : "";
}

/** Warm edits use compiler captures, so a checkout must use the compiler throughout its TS/JS corpus. */
export function engineWarmDecline(extractorVersion?: string): string | undefined {
  const storedLanguages = extractorVersion?.split("+engine-")[1]?.split("-") ?? [];
  if (graphEngineHandlesEcmaScript(graphEngineLanguages()) || graphEngineHandlesEcmaScript(storedLanguages)) {
    return "TypeScript or JavaScript is configured for the Rust graph engine. Edits use a normal graph refresh.";
  }
  return undefined;
}
