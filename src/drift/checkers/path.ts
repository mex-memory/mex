import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { globSync } from "glob";
import type { Claim, DriftIssue } from "../../types.js";

const PLACEHOLDER_WORDS = /(?:^|[/_-])(?:new|example|your|sample|my|foo|bar|placeholder|template)(?:[/_.-]|$)/i;

/** Scoped package pattern: @scope/name or @scope/name/sub/path */
const SCOPED_PACKAGE = /^@([\w-]+)\/([\w-]+)(\/.*)?$/;

/** URLs are not filesystem paths */
const URL_PATTERN = /^https?:\/\//;

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

  for (const claim of pathClaims) {
    // URLs are never filesystem paths
    if (URL_PATTERN.test(claim.value)) continue;

    if (pathExists(claim.value, projectRoot, scaffoldRoot, workspaceNames)) continue;

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
 * Collect the `name` field from each workspace's package.json.
 * Works with any package manager (npm, yarn, pnpm, bun) since it reads
 * the standard `workspaces` field from the root manifest.
 */
function collectWorkspaceNames(projectRoot: string): Set<string> {
  const names = new Set<string>();

  const rootPkgPath = resolve(projectRoot, "package.json");
  if (!existsSync(rootPkgPath)) return names;

  let rootPkg: { workspaces?: string[] | { packages?: string[] } };
  try {
    rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8"));
  } catch {
    return names;
  }

  // Normalize workspaces field (array or { packages: [...] })
  const patterns: string[] = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : rootPkg.workspaces?.packages ?? [];

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

function pathExists(
  value: string,
  projectRoot: string,
  scaffoldRoot: string,
  workspaceNames: Set<string>
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
      const req = createRequire(resolve(projectRoot, "package.json"));
      req.resolve(`${pkgName}/package.json`);
      return true;
    } catch {
      // Fall through to workspace check
    }

    // Check workspace names (handles package managers that don't symlink
    // all workspaces into node_modules, e.g. bun)
    if (workspaceNames.has(pkgName)) return true;
  }

  // Bare filenames: search recursively — the file may exist in a subdirectory
  if (!value.includes("/")) {
    const matches = globSync(`**/${value}`, {
      cwd: projectRoot,
      ignore: ["node_modules/**", ".mex/**", "dist/**", ".git/**"],
      maxDepth: 5,
    });
    if (matches.length > 0) return true;
  }

  return false;
}
