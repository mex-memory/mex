import type { DriftIssue, ScaffoldFrontmatter } from "../../types.js";

const RECOMMENDED_FIELDS = ["name", "description", "last_updated"] as const;

/** Warn when context/ or patterns/ files lack recommended frontmatter fields. */
export function checkFrontmatterCompleteness(
  frontmatter: ScaffoldFrontmatter | null,
  source: string
): DriftIssue[] {
  if (!isContextOrPatternFile(source)) return [];

  const issues: DriftIssue[] = [];
  const fm = frontmatter ?? {};

  for (const field of RECOMMENDED_FIELDS) {
    const value = fm[field];
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({
        code: "INCOMPLETE_FRONTMATTER",
        severity: "warning",
        file: source,
        line: null,
        message: `Missing recommended frontmatter field: ${field}`,
      });
    }
  }

  return issues;
}

function isContextOrPatternFile(source: string): boolean {
  return source.startsWith("context/") || source.startsWith("patterns/");
}
