// Which languages the Rust graph engine (OSS-73) builds instead of today's
// extractors. Kept apart from native-engine.ts so the manifest, which graph
// reads load, can fold the choice in without loading the engine client.

/** Languages the engine builds instead of today's extractors, e.g. `python`. */
export const GRAPH_ENGINE_LANGUAGES_ENV = "MEX_GRAPH_ENGINE_LANGUAGES";
/** Languages the engine can take over today. */
const ENGINE_LANGUAGES = new Set(["python"]);
/** Bumped when the engine's rows for a language change. */
const ENGINE_EXTRACTOR_VERSION = "v1";

/** The languages `MEX_GRAPH_ENGINE_LANGUAGES` hands to the engine (unknown names ignored), sorted. */
export function graphEngineLanguages(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env[GRAPH_ENGINE_LANGUAGES_ENV] ?? "").split(",").map((name) => name.trim().toLowerCase());
  return [...new Set(listed.filter((name) => ENGINE_LANGUAGES.has(name)))].sort();
}

/** The suffix an extractor version gains while the engine builds `languages`; empty without any. */
export function engineExtractorSuffix(languages: readonly string[]): string {
  return languages.length > 0 ? `+engine-${languages.join("-")}-${ENGINE_EXTRACTOR_VERSION}` : "";
}
