import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { globSync } from "glob";
import YAML from "yaml";
import { loadAllDependencies } from "./dependency.js";
import type { Claim, DriftIssue } from "../../types.js";

const PLACEHOLDER_WORDS = /(?:^|[/_-])(?:new|example|your|sample|my|foo|bar|placeholder|template)(?:[/_.-]|$)/i;

/** Naming-convention examples: `PascalCase.tsx` shows a shape, not a file. */
const NAMING_CONVENTION = /^(?:PascalCase|camelCase|kebab-case|snake_case|SCREAMING_SNAKE_CASE)\./;

/** Scoped package pattern: @scope/name or @scope/name/sub/path */
const SCOPED_PACKAGE = /^@([\w-]+)\/([\w-]+)(\/.*)?$/;

/** URLs are not filesystem paths */
const URL_PATTERN = /^(?:https?|ftp|file):\/\/|^\/\//;

/** A single-segment relative `.js` import specifier used in prose, not a repo path. */
const RELATIVE_JS_SPECIFIER = /^\.\/[^/]+\.js$/;

/** Words that mark prose about import specifiers rather than a file reference. */
const IMPORT_PROSE = /\b(?:import(?:s|ed|ing)?|specifier(?:s)?|esm|emitted)\b/i;

/** Basename of a file documented under `.mex/local/<name>`. */
const MEX_LOCAL_FILE = /^\.mex\/local\/([^/]+)$/;

/** Check that all claimed paths exist on disk */
export function checkPaths(
  claims: Claim[],
  projectRoot: string,
  scaffoldRoot: string
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const pathClaims = claims.filter(
    (c) => c.kind === "path" && !c.negated
  );

  // Collect workspace package names once for all claims
  const workspaceNames = collectWorkspaceNames(projectRoot);
  const declaredPackages = collectDeclaredPackageNames(projectRoot);
  const projectNames = collectProjectNames(projectRoot);
  const mexLocalBasenames = collectMexLocalBasenames(pathClaims);
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
    if (isUnrootedReference(claim.value, projectRoot, scaffoldRoot)) continue;

    // The npm package may be `hono` while JSR documents `@hono/hono`.
    if (projectNames.has(claim.value)) continue;

    // Prose sometimes names `.mex/local/hub-onboarding.json` and later `hub-onboarding.json`.
    if (!claim.value.includes("/") && mexLocalBasenames.has(claim.value)) continue;

    if (isImportSpecifierExample(claim, projectRoot)) continue;

    if (pathExists(
      claim.value,
      projectRoot,
      scaffoldRoot,
      workspaceNames,
      declaredPackages,
    )) continue;

    // A path the repository deliberately ignores is created at runtime, so its
    // absence from a clean checkout is expected rather than drift: `.mex/local/`
    // and `.mex/graph.db` are documented precisely because mex writes them.
    if (ignoredPaths.has(claim.value)) continue;

    // Downgrade to warning if: from a pattern file or path contains placeholder words.
    // Bare filenames that aren't found even after recursive search are genuinely missing.
    const isPattern = claim.source.includes("patterns/");
    const isPlaceholder = PLACEHOLDER_WORDS.test(claim.value);
    const severity = isPattern || isPlaceholder ? "warning" : "error";

    issues.push({
      code: "MISSING_PATH",
      severity,
      file: claim.source,
      line: claim.line,
      message: `Referenced path does not exist: ${claim.value}`,
      claim,
    });
  }

  return issues;
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
  if (value.startsWith("/")) return false;

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
function collectDeclaredPackageNames(projectRoot: string): Set<string> {
  const deps = loadAllDependencies(projectRoot);
  return new Set(deps?.map((entry) => entry.name) ?? []);
}

/** Names the project publishes under npm, JSR, or Deno. */
function collectProjectNames(projectRoot: string): Set<string> {
  const names = new Set<string>();

  const pkgPath = resolve(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
      if (pkg.name) names.add(pkg.name);
    } catch {
      // skip
    }
  }

  for (const manifest of ["jsr.json", "deno.json"] as const) {
    const manifestPath = resolve(projectRoot, manifest);
    if (!existsSync(manifestPath)) continue;
    try {
      const doc = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: string };
      if (doc.name) names.add(doc.name);
    } catch {
      // skip
    }
  }

  return names;
}

/** Basenames the scaffold documents under `.mex/local/<name>`. */
function collectMexLocalBasenames(claims: Claim[]): Set<string> {
  const basenames = new Set<string>();
  for (const claim of claims) {
    const match = claim.value.match(MEX_LOCAL_FILE);
    if (match) basenames.add(match[1]!);
  }
  return basenames;
}

/**
 * A `./file.js` token in a paragraph about imports names a specifier shape,
 * not a file at the repository root.
 */
function isImportSpecifierExample(claim: Claim, projectRoot: string): boolean {
  if (!RELATIVE_JS_SPECIFIER.test(claim.value)) return false;

  const filePath = resolve(projectRoot, claim.source);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  const lines = content.split(/\r?\n/);
  const lineIndex = Math.max(0, (claim.line ?? 1) - 1);
  let start = lineIndex;
  while (start > 0) {
    const previous = lines[start - 1]?.trim() ?? "";
    if (previous === "" || previous.startsWith("#")) break;
    start--;
  }
  let end = lineIndex;
  while (end < lines.length - 1) {
    const next = lines[end + 1]?.trim() ?? "";
    if (next === "" || next.startsWith("#")) break;
    end++;
  }

  return IMPORT_PROSE.test(lines.slice(start, end + 1).join(" "));
}

function collectIgnoredPaths(values: string[], projectRoot: string): Set<string> {
  const ignored = new Set<string>();
  const candidates = [...new Set(values)].filter((v) => v.length > 0);
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

/**
 * Collect the `name` field from each workspace's package.json.
 * Reads the root `workspaces` field (npm, yarn, bun) or falls back to
 * `pnpm-workspace.yaml` when that field is absent (pnpm monorepos).
 */
function collectWorkspaceNames(projectRoot: string): Set<string> {
  const names = new Set<string>();
  const patterns = collectWorkspacePatterns(projectRoot);

  for (const pattern of patterns) {
    const dirs = globSync(pattern, {
      cwd: projectRoot,
      ignore: ["node_modules/**"],
    });
    for (const dir of dirs) {
      const pkgPath = resolve(projectRoot, dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name) names.add(pkg.name);
      } catch {
        // Skip malformed package.json
      }
    }
  }

  return names;
}

function collectWorkspacePatterns(projectRoot: string): string[] {
  const rootPkgPath = resolve(projectRoot, "package.json");
  if (existsSync(rootPkgPath)) {
    try {
      const rootPkg: { workspaces?: string[] | { packages?: string[] } } = JSON.parse(
        readFileSync(rootPkgPath, "utf-8")
      );
      const patterns = Array.isArray(rootPkg.workspaces)
        ? rootPkg.workspaces
        : rootPkg.workspaces?.packages ?? [];
      if (patterns.length > 0) return patterns;
    } catch {
      // Fall through to pnpm-workspace.yaml
    }
  }

  const pnpmWorkspacePath = resolve(projectRoot, "pnpm-workspace.yaml");
  if (!existsSync(pnpmWorkspacePath)) return [];

  try {
    const doc = YAML.parse(readFileSync(pnpmWorkspacePath, "utf-8")) as {
      packages?: string[];
    } | null;
    return Array.isArray(doc?.packages) ? doc.packages : [];
  } catch {
    return [];
  }
}

function pathExists(
  value: string,
  projectRoot: string,
  scaffoldRoot: string,
  workspaceNames: Set<string>,
  declaredPackages: Set<string>,
): boolean {
  // Try project root first (e.g. src/index.ts)
  if (existsSync(resolve(projectRoot, value))) return true;

  // Try scaffold root (e.g. context/architecture.md when scaffold is in .mex/)
  if (scaffoldRoot !== projectRoot) {
    if (existsSync(resolve(scaffoldRoot, value))) return true;
  }

  // If path starts with .mex/, also check without that prefix
  // (handles the case where this repo IS the scaffold, not deployed inside .mex/)
  if (value.startsWith(".mex/")) {
    const withoutPrefix = value.slice(".mex/".length);
    if (existsSync(resolve(projectRoot, withoutPrefix))) return true;
  }

  // Resolve scoped package references (e.g. @acme/ui, @acme/shared/utils)
  const scopedMatch = value.match(SCOPED_PACKAGE);
  if (scopedMatch) {
    const pkgName = `@${scopedMatch[1]}/${scopedMatch[2]}`;

    // Try Node's module resolution first (works for installed npm packages)
    try {
      const req = createRequire(resolve(projectRoot, "noop.js"));
      req.resolve(`${pkgName}/package.json`);
      return true;
    } catch {
      // Fall through to workspace check
    }

    // Check workspace names (handles package managers that don't symlink
    // all workspaces into node_modules, e.g. bun)
    if (workspaceNames.has(pkgName)) return true;

    // A clone without node_modules still declares the package in a manifest.
    if (declaredPackages.has(pkgName)) return true;
  }

  // Bare filenames: search recursively — the file may exist in a subdirectory
  if (!value.includes("/")) {
    if (existsSync(resolve(projectRoot, ".mex/local", value))) return true;
    // `dot: true` so a file that lives in a hidden directory is found:
    // a backticked `deploy.yml` normally sits in `.github/workflows/`.
    const matches = globSync(`**/${value}`, {
      cwd: projectRoot,
      ignore: ["node_modules/**", ".mex/**", "dist/**", ".git/**"],
      maxDepth: 5,
      dot: true,
    });
    if (matches.length > 0) return true;

    // The project search skips the scaffold, so a scaffold file naming another
    // scaffold file -- `INDEX.md`, or a pattern by its filename -- found
    // nothing. Search the scaffold too when it is a directory of its own.
    if (scaffoldRoot !== projectRoot && existsSync(scaffoldRoot)) {
      const inScaffold = globSync(`**/${value}`, {
        cwd: scaffoldRoot,
        ignore: ["node_modules/**"],
        maxDepth: 5,
        dot: true,
      });
      if (inScaffold.length > 0) return true;
    }
  }

  // Documentation inside a subproject names paths from that subproject's root:
  // a backend's own docs say `routes/quiz.ts`, not
  // `server/src/routes/quiz.ts`. Accept the claim when exactly that suffix
  // exists somewhere in the repository, so a real file is not reported missing
  // because the reader started from a different directory than the author.
  if (value.includes("/") && !value.startsWith("/")) {
    const suffix = value.replace(/^\.\//, "").replace(/\/$/, "");
    const matches = globSync(`**/${suffix}`, {
      cwd: projectRoot,
      ignore: ["node_modules/**", "dist/**", ".git/**"],
      maxDepth: 6,
      dot: true,
    });
    if (matches.length > 0) return true;
  }

  return false;
}
