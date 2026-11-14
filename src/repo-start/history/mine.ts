/**
 * Code facts from one pass over the newest commits: files that change
 * together, generated files and layer rules. Pure functions over parsed
 * history, so the job, the tests and the held-out measure share them.
 */

export const HISTORY_LIMITS = Object.freeze({
  commits: 2000,
  /** Commits touching more files than this are bulk changes (formatting, version bumps). */
  bulkFiles: 30,
  /**
   * B changed in at least this share of the commits that changed A, and in at
   * least `support` of them. Chosen on a validation slice (never the test set)
   * of Hono, novu and django; see scripts/measure-change-together.ts.
   */
  confidence: 0.95,
  support: 4,
  pairs: 5000,
  generated: 5000,
  layerRules: 200,
  /** Imports needed one way before "the other way never" is a rule. */
  layerSupport: 3,
});

export interface Commit { hash: string; files: string[]; }
/** The parameters that decide which change-together pairs are kept. */
export interface PairParams { confidence: number; support: number; bulkFiles: number; }
export const PAIR_PARAMS: PairParams = { confidence: HISTORY_LIMITS.confidence, support: HISTORY_LIMITS.support, bulkFiles: HISTORY_LIMITS.bulkFiles };
/** The measure always counts test commits up to this size, whatever the learning cap, so the target never moves. */
export const EVALUATION_BULK_FILES = 30;
export interface ChangeTogether { a: string; b: string; confidence: number; support: number; }
export interface LayerRule { from: string; to: string; imports: number; }
export interface GeneratedFile { path: string; signal: "marker" | "gitattributes" | "history"; }

/** `git log --format=%x1e%H --name-only`, newest first. */
export function parseLog(text: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of text.split("\x1e")) {
    const lines = record.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const [hash, ...files] = lines;
    if (hash && /^[0-9a-f]{40,64}$/u.test(hash)) commits.push({ hash, files: [...new Set(files)] });
  }
  return commits;
}

/** Directional pairs: when A changes, B changes too. Bulk commits are left out. */
export function changeTogether(commits: Commit[], keep?: (path: string) => boolean, params: PairParams = PAIR_PARAMS): ChangeTogether[] {
  const count = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  for (const commit of commits) {
    if (commit.files.length < 2 || commit.files.length > params.bulkFiles) {
      if (commit.files.length === 1) count.set(commit.files[0]!, (count.get(commit.files[0]!) ?? 0) + 1);
      continue;
    }
    for (const a of commit.files) {
      count.set(a, (count.get(a) ?? 0) + 1);
      let row = pairs.get(a);
      if (!row) pairs.set(a, row = new Map());
      for (const b of commit.files) if (b !== a) row.set(b, (row.get(b) ?? 0) + 1);
    }
  }
  const out: ChangeTogether[] = [];
  for (const [a, row] of pairs) {
    if (keep && !keep(a)) continue;
    const total = count.get(a)!;
    for (const [b, support] of row) {
      if (support < params.support || (keep && !keep(b))) continue;
      const confidence = support / total;
      if (confidence >= params.confidence) out.push({ a, b, confidence: Math.round(confidence * 1000) / 1000, support });
    }
  }
  return out.sort((x, y) => y.support - x.support || x.a.localeCompare(y.a) || x.b.localeCompare(y.b)).slice(0, HISTORY_LIMITS.pairs);
}

export interface PrecisionResult { learn: number; test: number; rules: number; firings: number; hits: number; precision: number | null; lower: number; }

/** Wilson 95% lower bound: precision discounted for few firings. */
export function wilsonLower(hits: number, firings: number, z = 1.96): number {
  if (!firings) return 0;
  const p = hits / firings, z2 = z * z;
  return (p + z2 / (2 * firings) - z * Math.sqrt((p * (1 - p) + z2 / (4 * firings)) / firings)) / (1 + z2 / firings);
}

/** Learn pairs from `learn`, then count over every firing in `test`: when A changed, did B? */
export function precisionOn(learn: Commit[], test: Commit[], params: PairParams = PAIR_PARAMS): PrecisionResult {
  const eligible = test.filter(commit => commit.files.length >= 1 && commit.files.length <= EVALUATION_BULK_FILES);
  const rules = new Map<string, string[]>();
  for (const pair of changeTogether(learn, undefined, params)) rules.set(pair.a, [...(rules.get(pair.a) ?? []), pair.b]);
  let firings = 0, hits = 0;
  for (const commit of eligible) {
    const files = new Set(commit.files);
    for (const a of commit.files) for (const b of rules.get(a) ?? []) { firings++; if (files.has(b)) hits++; }
  }
  return {
    learn: learn.length, test: eligible.length, rules: [...rules.values()].reduce((sum, list) => sum + list.length, 0), firings, hits,
    precision: firings ? Math.round((hits / firings) * 1000) / 1000 : null, lower: Math.round(wilsonLower(hits, firings) * 1000) / 1000,
  };
}

/** Newest first: the newest 20% is the test set; the rest is learned from. */
export function testSplit(commits: Commit[]): { test: Commit[]; older: Commit[] } {
  const split = Math.floor(commits.length * 0.2);
  return { test: commits.slice(0, split), older: commits.slice(split) };
}

/**
 * Held-out precision (not shipped as a feature; the measure script uses it):
 * learn from the older 80% of the window, test on the newest 20%.
 */
export function heldOutPrecision(commits: Commit[], params: PairParams = PAIR_PARAMS): PrecisionResult {
  const { test, older } = testSplit(commits);
  return precisionOn(older, test, params);
}

/**
 * Choosing parameters without the test set: within the older 80%, learn from
 * the oldest three quarters and score on the newest quarter (the validation set).
 */
export function validationSplit(commits: Commit[]): { learn: Commit[]; validation: Commit[] } {
  const { older } = testSplit(commits);
  const split = Math.floor(commits.length * 0.2);
  return { validation: older.slice(0, split), learn: older.slice(split) };
}

/** The grid tried, fixed before any run. */
export const PARAM_GRID: PairParams[] = [0.8, 0.85, 0.9, 0.95, 1].flatMap(confidence =>
  [3, 4, 5, 6, 8, 10].flatMap(support => [5, 10, 20, 30].map(bulkFiles => ({ confidence, support, bulkFiles }))));

const MARKER = /@generated\b|\bDO NOT EDIT\b|^\s*(?:\/\/|#)\s*Code generated .* DO NOT EDIT\./mu;
/** A generated-file marker in the first five lines. */
export function hasGeneratedMarker(head: string): boolean {
  return MARKER.test(head.split(/\r?\n/u, 5).join("\n"));
}

/** gitattributes-style pattern → matcher: no slash matches a file name anywhere. */
function attributeMatcher(pattern: string): (path: string) => boolean {
  const anchored = pattern.includes("/") && !pattern.endsWith("/");
  const clean = pattern.replace(/^\//u, "").replace(/\/$/u, "/**");
  let source = "";
  for (let i = 0; i < clean.length; i++) {
    if (clean.startsWith("**/", i)) { source += "(?:.*/)?"; i += 2; continue; }
    if (clean.startsWith("**", i)) { source += ".*"; i += 1; continue; }
    const char = clean[i]!;
    source += char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.+^$()|[\]{}\\]/gu, "\\$&");
  }
  const regex = new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`, "u");
  return path => regex.test(path);
}

/** Paths `.gitattributes` marks `linguist-generated` (and not unset or false). */
export function attributeGenerated(gitattributes: string, paths: string[]): string[] {
  const rules: Array<{ match: (path: string) => boolean; on: boolean }> = [];
  for (const line of gitattributes.replace(/\r\n/gu, "\n").split("\n")) {
    const [pattern, ...attributes] = line.trim().split(/\s+/u);
    if (!pattern || pattern.startsWith("#")) continue;
    for (const attribute of attributes) {
      if (attribute === "linguist-generated" || attribute === "linguist-generated=true") rules.push({ match: attributeMatcher(pattern), on: true });
      else if (attribute === "-linguist-generated" || attribute === "linguist-generated=false" || attribute === "!linguist-generated") rules.push({ match: attributeMatcher(pattern), on: false });
    }
  }
  if (!rules.length) return [];
  // The last matching line wins, as in git.
  return paths.filter(path => { let on = false; for (const rule of rules) if (rule.match(path)) on = rule.on; return on; });
}

const GENERATOR = /(?:\.proto|\.graphql|\.gql|\.thrift|\.fbs|(?:^|\/)schema\.prisma|(?:^|\/)(?:openapi|swagger)[^/]*\.(?:ya?ml|json)|(?:^|\/)codegen[^/]*\.(?:ya?ml|json|ts|js)|(?:^|\/)[^/]*generate[^/]*\.(?:js|mjs|cjs|ts|py|sh|go))$/iu;
export function isGenerator(path: string): boolean { return GENERATOR.test(path); }

/**
 * Generated by history: every commit in the window that changed the path also
 * changed a generator config or script, at least twice, and it never changed alone.
 */
export function historyGenerated(commits: Commit[], keep?: (path: string) => boolean): string[] {
  const seen = new Map<string, { total: number; withGenerator: number }>();
  for (const commit of commits) {
    const generator = commit.files.some(isGenerator);
    for (const path of commit.files) {
      if (isGenerator(path)) continue;
      const row = seen.get(path) ?? { total: 0, withGenerator: 0 };
      row.total++;
      if (generator && commit.files.length > 1) row.withGenerator++;
      seen.set(path, row);
    }
  }
  return [...seen].filter(([path, row]) => row.withGenerator >= 2 && row.withGenerator === row.total && (!keep || keep(path))).map(([path]) => path).sort();
}

/**
 * Layer rules at the package or top-level-folder grain: Y imports X at least
 * `layerSupport` times and X never imports Y, so "X never imports Y" holds.
 */
export function layerRules(edges: Map<string, Map<string, number>>): LayerRule[] {
  const out: LayerRule[] = [];
  for (const [from, targets] of edges) {
    for (const [to, imports] of targets) {
      if (from === to || imports < HISTORY_LIMITS.layerSupport || (edges.get(to)?.get(from) ?? 0) > 0) continue;
      out.push({ from: to, to: from, imports });
    }
  }
  return out.sort((x, y) => y.imports - x.imports || x.from.localeCompare(y.from) || x.to.localeCompare(y.to)).slice(0, HISTORY_LIMITS.layerRules);
}

/** The unit (package folder, else top-level folder) a path belongs to. */
export function unitOf(path: string, packages: string[]): string | undefined {
  let best: string | undefined;
  for (const pkg of packages) if (pkg && (path === pkg || path.startsWith(`${pkg}/`)) && (!best || pkg.length > best.length)) best = pkg;
  if (best) return best;
  const slash = path.indexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}

/** Resolve an import to a unit: relative paths by location, bare names by package name. */
export function importTarget(file: string, from: string, packages: Array<{ path: string; name: string }>): string | undefined {
  if (from.startsWith("./") || from.startsWith("../")) {
    const parts = file.split("/").slice(0, -1);
    for (const part of from.split("/")) {
      if (part === "..") { if (!parts.length) return undefined; parts.pop(); }
      else if (part !== "." && part !== "") parts.push(part);
    }
    return unitOf(parts.join("/"), packages.map(pkg => pkg.path));
  }
  const name = from.startsWith("@") ? from.split("/").slice(0, 2).join("/") : from.split("/")[0]!;
  return packages.find(pkg => pkg.name === name && pkg.path)?.path;
}
