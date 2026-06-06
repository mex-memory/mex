import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DriftIssue, ScaffoldFrontmatter } from "../../types.js";

/** Check that all YAML frontmatter edge targets exist */
export function checkEdges(
  frontmatter: ScaffoldFrontmatter | null,
  filePath: string,
  source: string,
  projectRoot: string,
  scaffoldRoot: string
): DriftIssue[] {
  if (!frontmatter?.edges) return [];

  const issues: DriftIssue[] = [];

  for (const edge of frontmatter.edges) {
    if (!edge.target) continue;

    // Try project root, then scaffold root
    const fromProject = resolve(projectRoot, edge.target);
    const fromScaffold = resolve(scaffoldRoot, edge.target);
    if (!existsSync(fromProject) && !existsSync(fromScaffold)) {
      issues.push({
        code: "DEAD_EDGE",
        severity: "error",
        file: source,
        line: null,
        message: `Frontmatter edge target does not exist: ${edge.target}`,
      });
    }
  }

  return issues;
}
