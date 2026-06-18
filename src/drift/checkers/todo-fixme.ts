import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { DriftIssue } from "../../types.js";
import { toPosixPath } from "../../path-utils.js";

const MARKER_RE = /\b(TODO|FIXME)\b/g;

/** Scan scaffold markdown for unresolved TODO/FIXME markers. */
export function checkTodoFixme(
  scaffoldFiles: string[],
  projectRoot: string
): DriftIssue[] {
  const issues: DriftIssue[] = [];

  for (const filePath of scaffoldFiles) {
    const source = toPosixPath(relative(projectRoot, filePath));
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      MARKER_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MARKER_RE.exec(line)) !== null) {
        const marker = match[1];
        issues.push({
          code: "TODO_FIXME",
          severity: "warning",
          file: source,
          line: i + 1,
          message: `Unresolved ${marker} marker in scaffold`,
        });
      }
    }
  }

  return issues;
}
