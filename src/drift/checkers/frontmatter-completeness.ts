import { relative } from "node:path";
import type { DriftIssue, ScaffoldFrontmatter } from "../../types.js";
import { toPosixPath } from "../../path-utils.js";
import { parseFrontmatter } from "../frontmatter.js";

const REQUIRED_FIELDS = ["name", "description", "last_updated"] as const;

/** Warn when context/pattern scaffold files are missing required frontmatter. */
export function checkFrontmatterCompleteness(
  filePath: string,
  projectRoot: string,
  scaffoldRoot: string
): DriftIssue[] {
  const logicalPath = toPosixPath(relative(scaffoldRoot, filePath));
  if (!isRequiredFrontmatterFile(logicalPath)) return [];

  const source = toPosixPath(relative(projectRoot, filePath));
  const frontmatter = parseFrontmatter(filePath);
  const missingFields = missingRequiredFields(frontmatter);

  return missingFields.map((field) => ({
    code: "FRONTMATTER_MISSING_FIELD",
    severity: "warning",
    file: source,
    line: 1,
    message: `Required frontmatter field is missing or blank: ${field}`,
  }));
}

function missingRequiredFields(
  frontmatter: ScaffoldFrontmatter | null
): string[] {
  return REQUIRED_FIELDS.filter((field) => {
    const value = frontmatter?.[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

function isRequiredFrontmatterFile(path: string): boolean {
  return /^(context|patterns)\/[^/]+\.md$/i.test(path);
}
