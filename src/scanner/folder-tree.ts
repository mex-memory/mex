import { readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { FolderCategory } from "../types.js";

const CATEGORY_PATTERNS: Record<FolderCategory["category"], RegExp> = {
  routes: /^(routes?|pages?|api|endpoints?)/i,
  models: /^(models?|entities|schemas?|types?)/i,
  services: /^(services?|providers?|handlers?|controllers?|actions?)/i,
  tests: /^(tests?|__tests__|spec|__spec__)/i,
  config: /^(config|configs?|settings?)/i,
  utils: /^(utils?|helpers?|lib|shared|common)/i,
  views: /^(views?|components?|templates?|layouts?|ui)/i,
  other: /./,
};

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".mex",
]);

/** Scan top-level directories and categorize them */
export function scanFolderTree(projectRoot: string): FolderCategory[] {
  const categories: FolderCategory[] = [];

  let entries: string[];
  try {
    entries = readdirSync(projectRoot);
  } catch {
    return categories;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") && entry !== ".github") continue;
    if (IGNORE_DIRS.has(entry)) continue;

    const fullPath = resolve(projectRoot, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    const fileCount = countFiles(fullPath);
    const category = categorize(entry);

    categories.push({
      name: entry,
      path: entry,
      fileCount,
      category,
    });
  }

  return categories.sort((a, b) => b.fileCount - a.fileCount);
}

function categorize(dirName: string): FolderCategory["category"] {
  for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (category === "other") continue;
    if (pattern.test(dirName)) return category as FolderCategory["category"];
  }
  return "other";
}

function countFiles(dir: string, depth = 0): number {
  if (depth > 3) return 0; // Don't recurse too deep
  let count = 0;
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      if (IGNORE_DIRS.has(entry)) continue;
      const fullPath = resolve(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) count++;
        else if (stat.isDirectory()) count += countFiles(fullPath, depth + 1);
      } catch {
        continue;
      }
    }
  } catch {
    // skip
  }
  return count;
}
