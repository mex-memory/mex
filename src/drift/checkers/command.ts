import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Claim, DriftIssue } from "../../types.js";

const YARN_BUILTINS = new Set([
  "add",
  "audit",
  "autoclean",
  "bin",
  "cache",
  "check",
  "ci",
  "config",
  "constraints",
  "create",
  "dedupe",
  "dlx",
  "exec",
  "generate-lock-entry",
  "global",
  "help",
  "import",
  "info",
  "init",
  "install",
  "link",
  "list",
  "login",
  "logout",
  "node",
  "pack",
  "patch",
  "plugin",
  "policies",
  "publish",
  "remove",
  "run",
  "self-update",
  "set",
  "stage",
  "unlink",
  "unplug",
  "up",
  "upgrade",
  "upgrade-interactive",
  "version",
  "why",
  "workspace",
  "workspaces",
]);

const PNPM_BUILTINS = new Set([
  "add",
  "approve-builds",
  "audit",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "env",
  "exec",
  "fetch",
  "help",
  "i",
  "ignored-builds",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "ls",
  "outdated",
  "patch",
  "patch-commit",
  "patch-remove",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "root",
  "run",
  "self-update",
  "server",
  "setup",
  "store",
  "test",
  "un",
  "uninstall",
  "up",
  "update",
  "upgrade",
  "why",
]);

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

    // Explicit run always names a script, even when its name is a builtin.
    const explicitMatch = cmd.match(/^(?:npm|bun|yarn|pnpm)\s+run\s+(\S+)/);
    const shorthandMatch = cmd.match(/^(yarn|pnpm)\s+(\S+)/);
    const builtins = shorthandMatch?.[1] === "yarn" ? YARN_BUILTINS : PNPM_BUILTINS;
    const scriptName = explicitMatch?.[1] ?? (
      shorthandMatch && !builtins.has(shorthandMatch[2]) && !shorthandMatch[2].startsWith("-")
        ? shorthandMatch[2] : null
    );

    if (scriptName && !scriptName.startsWith("-")) {
      // `bun run test:{node,workerd}` runs one script per alternative. A name
      // still holding braces after expansion is a placeholder like `{script}`,
      // and a word naming too many scripts is skipped the same way.
      for (const script of new Set(expandBraces(scriptName) ?? [])) {
        if (/[{}]/.test(script)) continue;
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

/** More script names than anyone lists by hand; one Markdown token must stay bounded work. */
const MAX_BRACE_EXPANSIONS = 64;

/**
 * Shell brace expansion of comma lists: `a{b,c}` gives `ab` and `ac`.
 *
 * Each group multiplies the count, so twenty `{a,b}` groups would name a
 * million scripts. Expansion stops as soon as more than
 * {@link MAX_BRACE_EXPANSIONS} names would result, and the word is then not
 * read as a script list at all (null).
 */
function expandBraces(word: string): string[] | null {
  const expanded: string[] = [];
  // A stack, with alternatives pushed in reverse, keeps the written order.
  const pending = [word];
  while (pending.length > 0) {
    const next = pending.pop()!;
    const group = /\{([^{}]*,[^{}]*)\}/.exec(next);
    if (!group) {
      expanded.push(next);
      continue;
    }
    const head = next.slice(0, group.index);
    const tail = next.slice(group.index + group[0].length);
    const alternatives = group[1].split(",");
    for (let i = alternatives.length - 1; i >= 0; i--) {
      pending.push(head + alternatives[i] + tail);
    }
    // Every expansion replaces one word with at least two, so this count
    // never falls: once it is over the limit, the final result is too.
    if (expanded.length + pending.length > MAX_BRACE_EXPANSIONS) return null;
  }
  return expanded;
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
