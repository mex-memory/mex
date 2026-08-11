import type { DriftIssue, ScaffoldFrontmatter } from "../../types.js";

const RECOMMENDED_FIELDS = ["name", "description", "last_updated"] as const;

/** Flag context/ and patterns/ scaffold files missing recommended frontmatter fields */
export function checkFrontmatterCompleteness(
  frontmatter: ScaffoldFrontmatter | null,
  source: string
): DriftIssue[] {
  if (!frontmatter) return [];
  if (!/(^|\/)(context|patterns)\/[^/]+\.md$/.test(source)) return [];

  const issues: DriftIssue[] = [];
  for (const field of RECOMMENDED_FIELDS) {
    if (!frontmatter[field]) {
      issues.push({
        code: "MISSING_FRONTMATTER_FIELD",
        severity: "warning",
        file: source,
        line: null,
        message: `Missing recommended frontmatter field: \`${field}\``,
      });
    }
  }
  return issues;
}
