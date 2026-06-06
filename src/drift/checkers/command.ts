import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Claim, DriftIssue } from "../../types.js";

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
    const npmMatch = cmd.match(
      /^(?:npm\s+run|yarn|pnpm|bun\s+run)\s+(\S+)/
    );
    if (npmMatch) {
      const script = npmMatch[1];
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
