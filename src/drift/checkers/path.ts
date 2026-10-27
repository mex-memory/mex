import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseJsonc } from "../../jsonc.js";
import { RepositoryInventory } from "../repository.js";
import type { Claim, DriftIssue } from "../../types.js";

const PLACEHOLDER_WORDS = /(?:^|[/_-])(?:new|example|your|sample|my|foo|bar|placeholder|template)(?:[/_.-]|$)/i;

/** Naming-convention examples: `PascalCase.tsx` shows a shape, not a file. */
const NAMING_CONVENTION = /^(?:PascalCase|camelCase|kebab-case|snake_case|SCREAMING_SNAKE_CASE)\./;

/** Scoped package pattern: @scope/name or @scope/name/sub/path */
const SCOPED_PACKAGE = /^@([\w-]+)\/([\w-]+)(\/.*)?$/;

/** URLs are not filesystem paths */
const URL_PATTERN = /^(?:https?|ftp|file):\/\/|^\/\//;

const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/;

/** Check that all claimed paths exist on disk */
export function checkPaths(
  claims: Claim[],
  projectRoot: string,
  scaffoldRoot: string,
  repository = new RepositoryInventory(projectRoot),
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const pathClaims = claims.filter(
    (c) => c.kind === "path" && !c.negated
  );

  // Collect workspace package names once for all claims
  const packages = new Set(repository.manifests?.flatMap((pkg) => [pkg.name, ...Object.keys(pkg.dependencies)]).filter((name): name is string => !!name));
  const aliases = collectAliases(repository);
  const files = [...new Set([...(repository.files ?? []), ...repository.scaffoldFiles(scaffoldRoot)])];
  const suffixMatches = new Map<string, string[]>();
  const ignoredPaths = collectIgnoredPaths(
    pathClaims.map((c) => c.value),
    projectRoot
  );

  for (const claim of pathClaims) {
    // URLs are never filesystem paths
    if (URL_PATTERN.test(claim.value)) continue;

    // Naming-convention examples describe a shape, not a file on disk.
    if (NAMING_CONVENTION.test(claim.value)) continue;

    // An API route or a placeholder reads exactly like a relative directory
    // path -- `documents/upload`, `owner/repo`. What separates them from a real
    // reference is that nothing by the name of their first segment exists, so
    // treat those as prose rather than reporting a file that was never claimed.
    const alias = resolveAlias(claim.value, aliases, repository);
    if (alias === true) continue;
    const packageName = claim.value.match(SCOPED_PACKAGE)?.slice(1, 3).join("/");
    if (alias === null && packageName) {
      if (packages.has(`@${packageName}`)) continue;
      // An inline import specifier may discuss a transitive package or another
      // registry. It is not a claim that the project declares a direct dependency;
      // explicit dependency claims are checked by checkDependencies.
      continue;
    }
    if (alias === null && packages.has(claim.value.split("/")[0])) continue;
    if (alias === null && isUnrootedReference(claim.value, projectRoot, scaffoldRoot)) continue;
    const lookup = claim.value.startsWith("/") ? claim.value.slice(1) : claim.value;
    if (alias === null && pathExists(lookup, projectRoot, scaffoldRoot)) continue;
    if (alias === null && repository.files) {
      const suffix = lookup.replace(/^\.\//, "").replace(/\/$/, "");
      if (!suffixMatches.has(suffix)) suffixMatches.set(suffix, files.filter((file) => {
        const module = file.replace(SOURCE_EXTENSION, "");
        const candidates = [file];
        if (module !== file) {
          candidates.push(module);
          if (module.endsWith("/index")) candidates.push(module.slice(0, -6));
        }
        return candidates.some((candidate) => candidate === suffix || candidate.endsWith(`/${suffix}`)) && repository.safeFile(file);
      }));
      // Prose names files by base name or a partial path. The check asks whether
      // the referenced file exists, so any tracked file it names satisfies it;
      // several matches (`package.json`, `index.ts`) are not drift.
      if (suffixMatches.get(suffix)!.length > 0) continue;
    } else if (alias === null && repository.files === null) continue;

    // A path the repository deliberately ignores is created at runtime, so its
    // absence from a clean checkout is expected rather than drift: `.mex/local/`
    // and `.mex/graph.db` are documented precisely because mex writes them.
    if (ignoredPaths.has(claim.value)) continue;

    // Downgrade to warning if: from a pattern file or path contains placeholder words.
    // Bare filenames that aren't found even after recursive search are genuinely missing.
    const isPattern = claim.source.includes("patterns/");
    const isPlaceholder = PLACEHOLDER_WORDS.test(claim.value);
    // A capitalized bare name may be a prose name with an extension-shaped suffix.
    // Keep it visible as a warning; lowercase filenames and directory paths remain errors.
    const isProseName = /^[A-Z][^/\\]*\.[A-Za-z0-9]+$/u.test(claim.value);
    const severity = isPattern || isPlaceholder || isProseName ? "warning" : "error";

    issues.push({
      code: "MISSING_PATH",
      severity,
      file: claim.source,
      line: claim.line,
      message: `Referenced path does not exist: ${claim.value}`,
      claim,
    });
  }

  const namedInSource = collectSourceLiterals(issues, repository);
  return issues.filter((issue) => !namedInSource.has(issue.claim!.value));
}

/**
 * Build scripts can intentionally name absent legacy inputs. Accept only an
 * exact quoted path in tracked source, never Markdown or an arbitrary substring.
 * Git selects matching files in one bounded subprocess; safe reads then verify
 * literals without following symlinks. Failure retains the original findings.
 */
function collectSourceLiterals(issues: DriftIssue[], repository: RepositoryInventory): Set<string> {
  const found = new Set<string>();
  const candidates = [...new Set(issues.map((issue) => issue.claim!.value))]
    .filter((value) => value.includes("/") && SOURCE_EXTENSION.test(value) && !/[\n\r"'`]/.test(value));
  if (!candidates.length || candidates.length > 64 || candidates.join("\n").length > 16_384) return found;
  try {
    const output = execFileSync("git", ["grep", "-l", "-z", "-F", "-f", "-", "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.py", "*.go", "*.rs"], {
      cwd: repository.root, input: candidates.join("\n") + "\n", encoding: "utf8",
      maxBuffer: 1_048_576, timeout: 5000, stdio: ["pipe", "pipe", "ignore"],
    });
    const files = output.split("\0").filter(Boolean);
    if (files.length > 1024) return found;
    let remaining = 8_388_608;
    for (const file of files) {
      // Tests often retain obsolete example paths; they do not establish that
      // production code still names an input.
      if (/(?:^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec)\./.test(file)) continue;
      const content = repository.readBounded(file, Math.min(remaining, 1_048_576));
      if (content === null) continue;
      remaining -= Buffer.byteLength(content);
      for (const value of candidates) {
        if (["'", '"', "`"].some((quote) => content.includes(quote + value + quote))) found.add(value);
      }
      if (remaining <= 0) break;
    }
  } catch { /* Git unavailable, no matches, timeout or output limit: retain findings. */ }
  return found;
}

/**
 * True when a value names no file type and its first segment does not exist at
 * either root. API routes and placeholders take this shape; a real relative
 * path almost always starts from a directory that is actually there.
 *
 * A trailing separator marks a directory reference rather than disqualifying
 * the value. `screenshots/` in a layout note is prose when nothing by that name
 * is there, while `.mex/local/` still roots at a directory that exists and so
 * remains a claim the checker is entitled to test.
 */
function isUnrootedReference(
  value: string,
  projectRoot: string,
  scaffoldRoot: string
): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) {
    const first = value.slice(1).split("/")[0];
    return !!first && first !== "." && first !== ".."
      && !existsSync(resolve(projectRoot, first))
      && !existsSync(resolve(scaffoldRoot, first));
  }

  const trimmed = value.replace(/\/+$/, "");
  const isDirectoryRef = trimmed !== value;
  if (!trimmed.includes("/") && !isDirectoryRef) return false;
  if (/\.[A-Za-z0-9]+$/.test(trimmed)) return false;

  const first = trimmed.split("/")[0];
  if (!first || first.startsWith("@") || first === "." || first === "..") return false;

  if (existsSync(resolve(projectRoot, first))) return false;
  if (scaffoldRoot !== projectRoot && existsSync(resolve(scaffoldRoot, first))) return false;
  return true;
}

/**
 * Ask Git which of these paths are ignored. Documentation names generated
 * state -- a database, a local-only directory -- and that state is absent from
 * a clean checkout by design, so reporting it as a missing path is noise. One
 * batched call keeps this to a single subprocess per run; a checkout without
 * Git simply reports nothing ignored.
 */
function collectIgnoredPaths(values: string[], projectRoot: string): Set<string> {
  const ignored = new Set<string>();
  const candidates = [...new Set(values)].filter((value) => {
    // One outside path makes Git reject the entire batch. Check both separator
    // styles regardless of the host, and keep excluded values as normal claims.
    if (!value || /^(?:[/\\]|[A-Za-z]:)/.test(value) || /[\r\n\0]/.test(value)) return false;
    let depth = 0;
    for (const segment of value.split(/[/\\]/)) {
      if (segment === "..") {
        if (--depth < 0) return false;
      } else if (segment && segment !== ".") depth++;
    }
    return true;
  });
  if (candidates.length === 0) return ignored;

  try {
    const output = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: projectRoot,
      input: candidates.join("\n"),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) ignored.add(trimmed);
    }
  } catch (error) {
    // Exit code 1 means "nothing ignored" and carries partial stdout; any other
    // failure (no Git, not a repository) leaves the set empty.
    const stdout = (error as { stdout?: string | Buffer })?.stdout;
    if (typeof stdout === "string" || Buffer.isBuffer(stdout)) {
      for (const line of stdout.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) ignored.add(trimmed);
      }
    }
  }

  return ignored;
}

function pathExists(value: string, projectRoot: string, scaffoldRoot: string): boolean {
  if (existsSync(resolve(projectRoot, value))) return true;
  if (scaffoldRoot !== projectRoot && existsSync(resolve(scaffoldRoot, value))) return true;
  if (value.startsWith(".mex/") && existsSync(resolve(projectRoot, value.slice(5)))) return true;
  return false;
}

interface Alias { pattern: string; targets: string[] }
function collectAliases(repository: RepositoryInventory): Alias[] {
  const aliases: Alias[] = [];
  const cache = new Map<string, { base: string; paths: Record<string, string[]> }>();
  let remaining = 8_388_608;
  const load = (file: string, depth = 0): { base: string; paths: Record<string, string[]> } | null => {
    if (cache.has(file)) return cache.get(file)!;
    if (depth > 8 || remaining <= 0) return null;
    const content = repository.readBounded(file, Math.min(remaining, 1_048_576));
    if (content === null) return null;
    remaining -= Buffer.byteLength(content);
    let config;
    try {
      const parsed = parseJsonc(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      config = parsed as { extends?: string; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    } catch { return null; }
    const directory = dirname(resolve(repository.root, file));
    let parent: ReturnType<typeof load> = null;
    if (typeof config.extends === "string" && config.extends.startsWith(".")) {
      let extended = resolve(directory, config.extends);
      if (!extended.endsWith(".json")) extended += ".json";
      parent = load(relative(repository.root, extended).replace(/\\/g, "/"), depth + 1);
    }
    const options = config.compilerOptions ?? {};
    const result = { base: options.baseUrl ? resolve(directory, options.baseUrl) : parent?.base ?? directory,
      paths: options.paths ?? parent?.paths ?? {} };
    // Inherited mappings retain the directory in which they were authored.
    if (!options.paths && parent) result.base = parent.base;
    cache.set(file, result);
    return result;
  };
  const configs = repository.files?.filter((file) => /(^|\/)tsconfig[^/]*\.json$/.test(file)) ?? [];
  for (const file of configs.slice(0, 1024)) {
    const config = load(file);
    if (!config) continue;
    for (const [pattern, targets] of Object.entries(config.paths)) {
      if (Array.isArray(targets)) aliases.push({ pattern, targets: targets.filter((target) => typeof target === "string").map((target) => resolve(config.base, target)) });
    }
  }
  return aliases;
}

/** null means not an alias; false means an alias with no existing target. */
function resolveAlias(value: string, aliases: Alias[], repository: RepositoryInventory): boolean | null {
  let matched = false;
  for (const alias of aliases) {
    const star = alias.pattern.indexOf("*");
    const head = star < 0 ? alias.pattern : alias.pattern.slice(0, star);
    const tail = star < 0 ? "" : alias.pattern.slice(star + 1);
    if (star < 0 ? value !== head : !value.startsWith(head) || !value.endsWith(tail) || value.length < head.length + tail.length) continue;
    matched = true;
    const capture = star < 0 ? "" : value.slice(head.length, value.length - tail.length);
    for (const target of alias.targets) {
      const path = target.replace("*", capture);
      for (const extension of ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".json", "/index.ts", "/index.tsx", "/index.js"]) {
        if (repository.safeFile(relative(repository.root, path + extension))) return true;
      }
    }
  }
  return matched ? false : null;
}
