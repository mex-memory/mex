import type { Claim, DriftIssue } from "../../types.js";
import { dependencyEcosystem } from "../dependency-ecosystem.js";

/** Detect contradictions across scaffold files */
export function checkCrossFile(claims: Claim[]): DriftIssue[] {
  const issues: DriftIssue[] = [];

  // Group by name first so adding evidence to one claim does not stop it
  // being compared to legacy, unlabelled claims of the same package.
  const versionsByDep = new Map<string, Claim[]>();
  const versionValues = new Map<Claim, string>();
  for (const claim of claims.filter((c) => c.kind === "version" && !c.negated)) {
    const match = claim.value.match(/^(.+?)\s+v?(\d[\d.]*\S*)$/);
    if (!match) continue;
    const depName = match[1].trim().toLowerCase();
    if (!versionsByDep.has(depName)) versionsByDep.set(depName, []);
    versionsByDep.get(depName)!.push(claim);
    versionValues.set(claim, match[2]);
  }

  // Check for conflicting versions across different files
  for (const [dep, sameName] of versionsByDep) {
    const groups = new Map<Claim["ecosystem"], Claim[]>();
    for (const claim of sameName) {
      const key = dependencyEcosystem(claim);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(claim);
    }
    const identified = [...groups.entries()].filter(([ecosystem]) => ecosystem !== undefined).map(([, entries]) => entries);
    const comparisons = identified.length < 2 ? [sameName] : [...identified];
    if (identified.length > 1) {
      // An unlabelled claim may belong to either ecosystem. A matching version
      // is compatible with that candidate; one matching neither is still a
      // contradiction. Do not drop it just because a second ecosystem appears.
      const candidates = identified.flat();
      const candidateVersions = new Set(candidates.map((claim) => versionValues.get(claim)!));
      const incompatible = (groups.get(undefined) ?? []).filter((claim) => !candidateVersions.has(versionValues.get(claim)!));
      if (incompatible.length) comparisons.push([...incompatible, ...candidates]);
    }
    for (const versionClaims of comparisons) {
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
