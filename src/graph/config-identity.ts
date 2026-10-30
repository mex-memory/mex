import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * What a config file contributes to graph extraction, and nothing else.
 *
 * The build manifest folds the content of every `package.json`, `tsconfig` and
 * `jsconfig` in the repository. Hashing their bytes made a dependency version,
 * an npm script, an author field or a reindent look identical to a change in
 * how modules resolve, and each of those invalidated the whole index.
 *
 * This projects each file down to the fields that actually decide what the
 * compiler resolves and which files it reads. Everything else is dropped, so
 * changing it cannot invalidate anything.
 *
 * **The hazard runs the other way.** Over-hashing is noisy; under-hashing is
 * wrong, and silently — a field that affects extraction but is missing here
 * would let a stale index read as current with nothing to say otherwise. Every
 * field below is covered by a test asserting it still invalidates, and
 * anything this cannot parse falls back to its exact bytes.
 */

/** `compilerOptions` entries that change which declaration a reference binds to. */
const SIGNIFICANT_COMPILER_OPTIONS = Object.freeze([
  "allowJs",
  "baseUrl",
  "checkJs",
  "jsx",
  "module",
  "moduleResolution",
  "paths",
  "target",
] as const);

/** Top-level tsconfig/jsconfig entries that change which files are in a program. */
const SIGNIFICANT_TSCONFIG_FIELDS = Object.freeze([
  "exclude",
  "extends",
  "files",
  "include",
  "references",
] as const);

/** `package.json` entries that change module resolution or project layout. */
const SIGNIFICANT_PACKAGE_FIELDS = Object.freeze([
  "exports",
  "imports",
  "type",
  "workspaces",
] as const);

/** Dependency maps whose **names** shape resolution; their versions do not. */
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const);

export type GraphConfigKind = "package" | "tsconfig" | "unknown";

/** Classify by file name; the corpus policy only admits these three shapes. */
export function graphConfigKind(path: string): GraphConfigKind {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "package.json") return "package";
  if (/^(?:ts|js)config.*\.json$/u.test(name)) return "tsconfig";
  return "unknown";
}

/**
 * A canonical string standing for everything in this file that can change the
 * graph.
 *
 * Falls back to the exact source whenever the projection cannot be trusted:
 * an unparseable file, an unrecognized name, or a document that is not a JSON
 * object. Failing towards over-invalidation keeps an unreadable config from
 * quietly meaning "nothing changed".
 */
export function graphConfigIdentity(path: string, source: string): string {
  const kind = graphConfigKind(path);
  if (kind === "unknown") return source;
  const parsed = parseJsonWithComments(path, source);
  if (parsed === undefined) return source;
  const projected = kind === "package" ? projectPackage(parsed) : projectTsconfig(parsed);
  return projected === undefined ? source : canonicalize(projected);
}

/** tsconfig is JSON with comments and trailing commas; byte comparison is not parsing. */
function parseJsonWithComments(path: string, source: string): unknown {
  // JSONC's strings must be preserved before removing comments or commas.
  // Unusual or malformed syntax goes through the original compiler parser.
  try {
    const commentsRemoved = source.replace(/^\uFEFF/u, "").replace(
      /"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\//gu,
      token => token.startsWith("/") ? " " : token,
    );
    const json = commentsRemoved.replace(/"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])/gu,
      (token, offset: number) => {
        if (!token.startsWith(",")) return token;
        const previous = commentsRemoved.slice(0, offset).trimEnd().at(-1);
        return previous && !"[{,:".includes(previous) ? "" : token;
      });
    return JSON.parse(json, (key, value: unknown) => {
      // The original object converter has special prototype-key semantics.
      if (key === "__proto__") throw new Error("Use the original config parser.");
      return value;
    });
  } catch {
    // Keep the compiler's exact accepted syntax and error behavior.
  }
  const ts: typeof import("typescript") = require("typescript");
  const result = ts.parseConfigFileTextToJson(path, source);
  if (result.error || result.config === undefined) return undefined;
  return result.config;
}

function projectTsconfig(config: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(config)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const field of SIGNIFICANT_TSCONFIG_FIELDS) {
    if (field in config) projected[field] = config[field];
  }
  const options = config.compilerOptions;
  if (isPlainObject(options)) {
    const significant: Record<string, unknown> = {};
    for (const option of SIGNIFICANT_COMPILER_OPTIONS) {
      if (option in options) significant[option] = options[option];
    }
    if (Object.keys(significant).length > 0) projected.compilerOptions = significant;
  } else if (options !== undefined) {
    // A compilerOptions that is not an object is malformed; do not claim to
    // have understood it.
    return undefined;
  }
  return projected;
}

function projectPackage(config: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(config)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const field of SIGNIFICANT_PACKAGE_FIELDS) {
    if (field in config) projected[field] = config[field];
  }
  // A dependency's presence can change resolution; its version cannot change
  // anything this graph extracts, and versions are what actually move.
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const entry = config[field];
    if (isPlainObject(entry)) for (const name of Object.keys(entry)) names.add(name);
    else if (entry !== undefined) return undefined;
  }
  if (names.size > 0) projected.dependencyNames = [...names].sort(compareCodePoints);
  return projected;
}

/**
 * Serialize with object keys in a fixed order so reordering or reindenting a
 * file cannot change the result, while preserving array order, which is
 * meaningful in `paths`, `include` and `references`.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) out[key] = normalize(value[key]);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
