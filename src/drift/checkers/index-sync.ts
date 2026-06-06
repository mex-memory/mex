import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { globSync } from "glob";
import type { DriftIssue } from "../../types.js";

/** Cross-reference patterns/INDEX.md with actual pattern files */
export function checkIndexSync(projectRoot: string, scaffoldRoot: string): DriftIssue[] {
  // Try scaffold root first (deployed as .mex/), then project root
  let patternsDir = resolve(scaffoldRoot, "patterns");
  if (!existsSync(patternsDir)) {
    patternsDir = resolve(projectRoot, "patterns");
  }
  const indexPath = resolve(patternsDir, "INDEX.md");

  if (!existsSync(indexPath)) return [];
  if (!existsSync(patternsDir)) return [];

  const issues: DriftIssue[] = [];

  // Get actual pattern files (exclude INDEX.md and README.md)
  const patternFiles = globSync("*.md", { cwd: patternsDir, ignore: ["node_modules/**"] })
    .filter((f) => f !== "INDEX.md" && f !== "README.md");

  // Parse INDEX.md for referenced files (strip HTML comments first)
  const rawContent = readFileSync(indexPath, "utf-8");
  const indexContent = rawContent.replace(/<!--[\s\S]*?-->/g, "");
  const referencedFiles = new Set<string>();
  const linkPattern = /\[.*?\]\((.+?\.md(?:#[\w-]+)?)\)/g;
  let match;
  while ((match = linkPattern.exec(indexContent)) !== null) {
    // Strip anchor fragments for file existence checks
    referencedFiles.add(match[1].replace(/#.*$/, ""));
  }

  // Also match bare backtick references
  const backtickPattern = /`([\w-]+\.md)`/g;
  while ((match = backtickPattern.exec(indexContent)) !== null) {
    referencedFiles.add(match[1]);
  }

  // Check: pattern files not in INDEX
  for (const file of patternFiles) {
    if (!referencedFiles.has(file)) {
      issues.push({
        code: "INDEX_MISSING_ENTRY",
        severity: "warning",
        file: "patterns/INDEX.md",
        line: null,
        message: `Pattern file patterns/${file} exists but is not referenced in INDEX.md`,
      });
    }
  }

  // Check: INDEX references that don't exist as files
  for (const ref of referencedFiles) {
    const refPath = resolve(patternsDir, ref);
    if (!existsSync(refPath)) {
      issues.push({
        code: "INDEX_ORPHAN_ENTRY",
        severity: "warning",
        file: "patterns/INDEX.md",
        line: null,
        message: `INDEX.md references ${ref} but the file does not exist`,
      });
    }
  }

  return issues;
}
