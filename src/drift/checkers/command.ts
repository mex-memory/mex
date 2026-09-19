import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Claim, DriftIssue } from "../../types.js";

/**
 * First-token verbs that yarn/pnpm treat as their own commands. Bare
 * `yarn install` / `pnpm add` must not be looked up as package.json scripts.
 * `run` is handled separately so `yarn run <script>` still checks scripts.
 */
const YARN_PNPM_BUILTINS = new Set([
  "add",
  "audit",
  "bin",
  "cache",
  "ci",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "doctor",
  "env",
  "exec",
  "explain",
  "fetch",
  "focus",
  "global",
  "help",
  "import",
  "init",
  "install",
  "link",
  "list",
  "login",
  "logout",
  "ls",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "plugin",
  "prune",
  "publish",
  "rebuild",
  "recursive",
  "remove",
  "root",
  "set",
  "setup",
  "store",
  "uninstall",
  "unlink",
  "unset",
  "unplug",
  "up",
  "update",
  "upgrade",
  "version",
  "why",
  "workspace",
  "workspaces",
  "i",
  "rm",
]);

/** Resolve a package-manager invocation to a script name, or null if it is not a script lookup. */
function packageManagerScriptName(cmd: string): string | null {
  const scopedRun = cmd.match(/^(?:npm|yarn|pnpm|bun)\s+run\s+(\S+)/);
  if (scopedRun) return scopedRun[1];

  const bare = cmd.match(/^(?:yarn|pnpm)\s+(\S+)/);
  if (!bare) return null;
  return YARN_PNPM_BUILTINS.has(bare[1]) ? null : bare[1];
}

/** Check that claimed npm/yarn/make commands actually exist */
export function checkCommands(
  claims: Claim[],
  projectRoot: string
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const commandClaims = claims.filter(
    (c) => c.kind === "command" && !c.negated
  );

  const pkgScripts = loadPackageScripts(projectRoot);
  const makeTargets = loadMakeTargets(projectRoot);

  for (const claim of commandClaims) {
    const cmd = claim.value.trim();

    // npm run <script> / yarn <script> / pnpm <script>
    const script = packageManagerScriptName(cmd);
    if (script !== null) {
      if (pkgScripts && !pkgScripts.has(script)) {
        issues.push({
          code: "DEAD_COMMAND",
          severity: "error",
          file: claim.source,
          line: claim.line,
          message: `Script "${script}" not found in package.json scripts`,
          claim,
        });
      }
      continue;
    }

    // make <target>
    const makeMatch = cmd.match(/^make\s+(\S+)/);
    if (makeMatch) {
      const target = makeMatch[1];
      if (makeTargets && !makeTargets.has(target)) {
        issues.push({
          code: "DEAD_COMMAND",
          severity: "error",
          file: claim.source,
          line: claim.line,
          message: `Make target "${target}" not found in Makefile`,
          claim,
        });
      }
    }
  }

  return issues;
}

function loadPackageScripts(
  projectRoot: string
): Set<string> | null {
  const pkgPath = resolve(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return null;
  }
}

function loadMakeTargets(projectRoot: string): Set<string> | null {
  const makePath = resolve(projectRoot, "Makefile");
  if (!existsSync(makePath)) return null;
  try {
    const content = readFileSync(makePath, "utf-8");
    const targets = new Set<string>();
    for (const line of content.split("\n")) {
      const match = line.match(/^(\w[\w-]*):/);
      if (match) targets.add(match[1]);
    }
    return targets;
  } catch {
    return null;
  }
}
