import { basename } from "node:path";
import type { DriftIssue, ScaffoldFrontmatter } from "../../types.js";

const RECOMMENDED_FIELDS = ["name", "description", "last_updated"] as const;
const EXCLUDED_PATTERN_FILES = new Set(["INDEX.md", "README.md"]);

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
  if (EXCLUDED_PATTERN_FILES.has(basename(source))) return false;
  // Match both root-layout (context/foo.md) and deployed (.mex/context/foo.md) paths.
  return /(^|\/)context\//.test(source) || /(^|\/)patterns\//.test(source);
}
