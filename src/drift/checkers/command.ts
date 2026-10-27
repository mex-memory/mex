import { RepositoryInventory } from "../repository.js";
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
  projectRoot: string,
  repository = new RepositoryInventory(projectRoot),
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const commandClaims = claims.filter(
    (c) => c.kind === "command" && !c.negated
  );

  const pkgScripts = repository.manifests?.length ? new Set(repository.manifests.flatMap((pkg) => Object.keys(pkg.scripts))) : null;
  const makeTargets = loadMakeTargets(projectRoot);
  let nxTargets: Map<string, Set<string>> | null | undefined;

  for (const claim of commandClaims) {
    const cmd = claim.value.trim().replace(/^cd\s+[^&\n]+&&\s*/, "").replace(/^(pnpm|npm|yarn|bun)\s+(?:(?:--filter|-F|--workspace|-w|--dir|-C)\s+\S+\s+|--filter=\S+\s+|--recursive\s+|-r\s+)+/, "$1 ");
    const nx = cmd.match(/^(?:npx\s+|pnpm\s+(?:exec\s+)?)?nx\s+run\s+([^: ]+):([^: ]+)/);
    if (nx) {
      nxTargets ??= loadNxTargets(repository);
      if (nxTargets && !nxTargets.get(nx[1])?.has(nx[2])) issues.push({
        code: "DEAD_COMMAND", severity: "error", file: claim.source, line: claim.line,
        message: `Target "${nx[1]}:${nx[2]}" not found in workspace scripts or project targets`, claim,
      });
      continue;
    }

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
        const template = /<[^<>\s]+>/.test(script);
        if (pkgScripts && !(template ? [...pkgScripts].some((name) => matchesScriptTemplate(script, name)) : pkgScripts.has(script))) {
          issues.push({
            code: "DEAD_COMMAND",
            severity: "error",
            file: claim.source,
            line: claim.line,
            message: template
              ? `Script template "${script}" matches no package.json script`
              : `Script "${script}" not found in package.json scripts`,
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

/** Match literal segments in order, without interpreting regex or shell syntax. */
function matchesScriptTemplate(template: string, script: string): boolean {
  const parts = template.split(/<[^<>\s]+>/);
  const first = parts.shift()!;
  const last = parts.pop()!;
  if (!script.startsWith(first) || !script.endsWith(last)) return false;
  let offset = first.length;
  const end = script.length - last.length;
  for (const part of parts) {
    const next = script.indexOf(part, offset);
    if (next < 0 || next + part.length > end) return false;
    offset = next + part.length;
  }
  return offset <= end;
}

/** Read explicit project targets once; abstain if this corpus is incomplete. */
function loadNxTargets(repository: RepositoryInventory): Map<string, Set<string>> | null {
  if (repository.manifests === null || repository.files === null) return null;
  const projects = new Map<string, Set<string>>();
  const add = (name: string, targets: string[]) => {
    const existing = projects.get(name) ?? new Set<string>();
    targets.forEach((target) => existing.add(target));
    projects.set(name, existing);
  };
  for (const pkg of repository.manifests) {
    const targets = [...Object.keys(pkg.scripts), ...Object.keys(pkg.targets)];
    if (pkg.name) add(pkg.name, targets);
    add(basename(dirname(pkg.path)), targets);
  }
  const files = repository.files.filter((file) => /(^|\/)project\.json$/.test(file));
  if (files.length > 1024) return null;
  let remaining = 8_388_608;
  for (const file of files) {
    try {
      const content = repository.readBounded(file, Math.min(remaining, 1_048_576));
      if (content === null) return null;
      remaining -= Buffer.byteLength(content);
      const config = JSON.parse(content);
      add(config.name ?? basename(dirname(file)), Object.keys(config.targets ?? {}));
    } catch { return null; }
  }
  return projects;
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
  // Adjacent pipes in a script token denote prose alternatives. Whitespace
  // pipelines and shell || are deliberately outside this notation.
  const alternatives = word.split("|");
  const pending = alternatives.length > 1 && alternatives.every((part) => /^[\w:.-]+$/.test(part))
    ? alternatives.reverse() : [word];
  if (pending.length > MAX_BRACE_EXPANSIONS) return null;
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
