import type { DriftIssue, ScaffoldFrontmatter } from "../../types.js";

const RECOMMENDED_FIELDS = ["name", "description", "last_updated"] as const;

const IN_SCOPE = /(^|\/)(context|patterns)\/([^/]+\.md)$/;

/** Navigational files under `patterns/`, not patterns themselves — shipped
 *  without frontmatter by the templates, and excluded from index-sync and
 *  stale-pattern for the same reason. Deliberately scoped to `patterns/`:
 *  every `context/*.md` is in scope, same-named files included. */
const EXEMPT_PATTERN_FILES = new Set(["INDEX.md", "README.md"]);

/** Flag context/ and patterns/ scaffold files missing recommended frontmatter fields */
export function checkFrontmatterCompleteness(
  frontmatter: ScaffoldFrontmatter | null,
  source: string
): DriftIssue[] {
  const scope = IN_SCOPE.exec(source);
  if (!scope) return [];
  const [, , dir, filename] = scope;
  if (dir === "patterns" && EXEMPT_PATTERN_FILES.has(filename)) return [];

  const fm = frontmatter ?? {};
  const issues: DriftIssue[] = [];
  for (const field of RECOMMENDED_FIELDS) {
    if (!fm[field]) {
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
