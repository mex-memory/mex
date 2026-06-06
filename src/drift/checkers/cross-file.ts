import type { Claim, DriftIssue } from "../../types.js";

/** Detect contradictions across scaffold files */
export function checkCrossFile(claims: Claim[]): DriftIssue[] {
  const issues: DriftIssue[] = [];

  // Group version claims by dependency name
  const versionsByDep = new Map<string, Claim[]>();
  for (const claim of claims.filter((c) => c.kind === "version" && !c.negated)) {
    const match = claim.value.match(/^(.+?)\s+v?(\d[\d.]*\S*)$/);
    if (!match) continue;
    const depName = match[1].trim().toLowerCase();
    if (!versionsByDep.has(depName)) versionsByDep.set(depName, []);
    versionsByDep.get(depName)!.push(claim);
  }

  // Check for conflicting versions across different files
  for (const [dep, versionClaims] of versionsByDep) {
    if (versionClaims.length < 2) continue;

    const uniqueVersions = new Set(versionClaims.map((c) => c.value));
    if (uniqueVersions.size > 1) {
      const sources = versionClaims
        .map((c) => `${c.source}:${c.line} says "${c.value}"`)
        .join(", ");
      issues.push({
        code: "CROSS_FILE_CONFLICT",
        severity: "error",
        file: versionClaims[0].source,
        line: versionClaims[0].line,
        message: `Conflicting versions for "${dep}": ${sources}`,
      });
    }
  }

  // Group command claims that reference the same script
  const commandsByScript = new Map<string, Claim[]>();
  for (const claim of claims.filter((c) => c.kind === "command" && !c.negated)) {
    const npmMatch = claim.value.match(
      /^(?:npm\s+run|yarn|pnpm|bun\s+run)\s+(\S+)/
    );
    if (npmMatch) {
      const script = npmMatch[1];
      if (!commandsByScript.has(script)) commandsByScript.set(script, []);
      commandsByScript.get(script)!.push(claim);
    }
  }

  // Check for same script referenced with different package managers
  for (const [script, cmdClaims] of commandsByScript) {
    if (cmdClaims.length < 2) continue;
    const fromDifferentFiles = new Set(cmdClaims.map((c) => c.source)).size > 1;
    if (!fromDifferentFiles) continue;

    const managers = new Set(
      cmdClaims.map((c) => c.value.split(/\s/)[0])
    );
    if (managers.size > 1) {
      issues.push({
        code: "CROSS_FILE_CONFLICT",
        severity: "warning",
        file: cmdClaims[0].source,
        line: cmdClaims[0].line,
        message: `Script "${script}" referenced with different package managers across files: ${[...managers].join(", ")}`,
      });
    }
  }

  return issues;
}
