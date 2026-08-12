import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "glob";
import type { DriftIssue } from "../../types.js";
import { extractFrontmatter } from "../../markdown.js";

const EDGE_TARGET_PATTERN = /(?:^|\/)patterns\/([^/]+\.md)$/;

/**
 * Flag pattern files with no inbound reference from ROUTER.md or context/*.md.
 * Distinct from `checkIndexSync`, which cross-references patterns/INDEX.md
 * against the files on disk — this checker looks for links from the rest of
 * the scaffold, so a pattern can be listed in INDEX.md yet still be orphaned
 * from the routing table and context docs that would actually lead an agent
 * to load it.
 */
export function checkStalePatterns(projectRoot: string, scaffoldRoot: string): DriftIssue[] {
  let patternsDir = resolve(scaffoldRoot, "patterns");
  if (!existsSync(patternsDir)) {
    patternsDir = resolve(projectRoot, "patterns");
  }
  if (!existsSync(patternsDir)) return [];

  const patternFiles = globSync("*.md", { cwd: patternsDir, ignore: ["node_modules/**"] }).filter(
    (f) => f !== "INDEX.md" && f !== "README.md"
  );
  if (patternFiles.length === 0) return [];

  const referencingFiles: string[] = [];

  let routerPath = resolve(scaffoldRoot, "ROUTER.md");
  if (!existsSync(routerPath)) routerPath = resolve(projectRoot, "ROUTER.md");
  if (existsSync(routerPath)) referencingFiles.push(routerPath);

  let contextDir = resolve(scaffoldRoot, "context");
  if (!existsSync(contextDir)) contextDir = resolve(projectRoot, "context");
  if (existsSync(contextDir)) {
    referencingFiles.push(
      ...globSync("*.md", { cwd: contextDir, ignore: ["node_modules/**"] }).map((f) =>
        resolve(contextDir, f)
      )
    );
  }

  const referencedFiles = new Set<string>();
  for (const filePath of referencingFiles) {
    const rawContent = readFileSync(filePath, "utf-8");
    const content = rawContent.replace(/<!--[\s\S]*?-->/g, "");

    const linkPattern = /\[.*?\]\((?:\.\.?\/)?patterns\/(.+?\.md)(?:#[\w-]+)?\)/g;
    let match;
    while ((match = linkPattern.exec(content)) !== null) {
      referencedFiles.add(match[1]);
    }

    const backtickPattern = /`([\w-]+\.md)`/g;
    while ((match = backtickPattern.exec(content)) !== null) {
      referencedFiles.add(match[1]);
    }

    // Frontmatter edges are mex's canonical navigation, so a pattern reached
    // only through an edge is not orphaned. Parsed from the content already
    // read above rather than re-reading the file.
    const edges = extractFrontmatter(rawContent)?.edges;
    for (const edge of Array.isArray(edges) ? edges : []) {
      const edgeMatch = edge?.target ? EDGE_TARGET_PATTERN.exec(edge.target) : null;
      if (edgeMatch) referencedFiles.add(edgeMatch[1]);
    }
  }

  const issues: DriftIssue[] = [];
  for (const file of patternFiles) {
    if (!referencedFiles.has(file)) {
      issues.push({
        code: "STALE_PATTERN",
        severity: "warning",
        file: `patterns/${file}`,
        line: null,
        message: `Pattern file patterns/${file} is not referenced from ROUTER.md or context/*.md`,
      });
    }
  }

  return issues;
}
