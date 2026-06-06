import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { globSync } from "glob";
import type { DriftIssue } from "../../types.js";

const LINK_RE = /\[.*?\]\((.+?\.md(?:#[\w-]+)?)\)/g;
const BACKTICK_MD_RE = /`([\w-]+\.md)`/g;

/** Pattern files not linked from ROUTER.md or context/*.md (orphans in nav graph). */
export function checkStalePatterns(
  projectRoot: string,
  scaffoldRoot: string,
): DriftIssue[] {
  // Try scaffold root first (deployed as .mex/), then project root
  let patternsDir = resolve(scaffoldRoot, "patterns");
  if (!existsSync(patternsDir)) {
    patternsDir = resolve(projectRoot, "patterns");
  }
  if (!existsSync(patternsDir)) return [];

  const patternFiles = globSync("*.md", {
    cwd: patternsDir,
    ignore: ["node_modules/**"],
  }).filter((f) => f !== "INDEX.md" && f !== "README.md");
  if (patternFiles.length === 0) return [];

  const referenced = new Set<string>();
  const contextDir = resolve(scaffoldRoot, "context");
  const contextSources = existsSync(contextDir)
    ? globSync("*.md", { cwd: contextDir }).map((f) => resolve(contextDir, f))
    : [];
  const sources = [resolve(scaffoldRoot, "ROUTER.md"), ...contextSources];

  for (const filePath of sources) {
    if (!existsSync(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    collectPatternRefs(content.replace(/<!--[\s\S]*?-->/g, ""), referenced);
  }

  const issues: DriftIssue[] = [];
  for (const file of patternFiles) {
    const ref = `patterns/${file}`;
    if (!referenced.has(file) && !referenced.has(ref)) {
      issues.push({
        code: "STALE_PATTERN",
        severity: "warning",
        file: relative(projectRoot, resolve(patternsDir, file)),
        line: null,
        message: `Pattern ${ref} is not linked from ROUTER.md or context/*.md`,
      });
    }
  }
  return issues;
}

function collectPatternRefs(content: string, out: Set<string>): void {
  let match: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(content)) !== null) {
    const target = match[1].replace(/#.*$/, "").replace(/^\.\//, "");
    out.add(target);
    out.add(target.split("/").pop()!);
  }
  BACKTICK_MD_RE.lastIndex = 0;
  while ((match = BACKTICK_MD_RE.exec(content)) !== null) {
    out.add(match[1]);
    out.add(`patterns/${match[1]}`);
  }
}
