import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { toPosix } from "../../paths.js";
import type { DriftIssue } from "../../types.js";

const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

/** Scan scaffold markdown for local links whose target file does not exist. */
export function checkBrokenLinks(
  scaffoldFiles: string[],
  projectRoot: string,
  scaffoldRoot: string
): DriftIssue[] {
  const issues: DriftIssue[] = [];

  for (const filePath of scaffoldFiles) {
    const source = toPosix(relative(projectRoot, filePath));
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const fileDir = dirname(filePath);
    const lines = content.split("\n");
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const scanLine = line.replace(/`[^`]+`/g, "");
      LINK_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = LINK_RE.exec(scanLine)) !== null) {
        const rawTarget = match[2].trim();
        const target = normalizeLinkTarget(rawTarget);
        if (!target || isExternalOrAnchor(target)) continue;

        if (!linkTargetExists(target, fileDir, projectRoot, scaffoldRoot)) {
          const isPattern = source.includes("patterns/");
          issues.push({
            code: "BROKEN_LINK",
            severity: isPattern ? "warning" : "error",
            file: source,
            line: i + 1,
            message: `Markdown link target does not exist: ${target}`,
          });
        }
      }
    }
  }

  return issues;
}

function normalizeLinkTarget(raw: string): string {
  let target = raw.replace(/^<|>$/g, "").trim();
  const titleSplit = target.match(/^([^\s]+)(?:\s+["'].+["'])?$/);
  if (titleSplit) target = titleSplit[1];
  target = target.replace(/[#?].*$/, "");
  return target;
}

function isExternalOrAnchor(target: string): boolean {
  return (
    /^https?:\/\//i.test(target) ||
    /^mailto:/i.test(target) ||
    /^mex:\/\//i.test(target) ||
    target.startsWith("#")
  );
}

function linkTargetExists(
  target: string,
  fileDir: string,
  projectRoot: string,
  scaffoldRoot: string
): boolean {
  const fromFile = resolve(fileDir, target);
  if (existsSync(fromFile)) return true;

  if (existsSync(resolve(projectRoot, target))) return true;

  if (scaffoldRoot !== projectRoot && existsSync(resolve(scaffoldRoot, target))) {
    return true;
  }

  if (target.startsWith(".mex/")) {
    const withoutPrefix = target.slice(".mex/".length);
    if (existsSync(resolve(projectRoot, withoutPrefix))) return true;
  }

  return false;
}
