import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Read README content if it exists */
export function scanReadme(projectRoot: string): string | null {
  const candidates = ["README.md", "readme.md", "Readme.md", "README"];

  for (const name of candidates) {
    const path = resolve(projectRoot, name);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        // Truncate to first 3000 chars to keep brief compact
        return content.length > 3000
          ? content.slice(0, 3000) + "\n... (truncated)"
          : content;
      } catch {
        return null;
      }
    }
  }

  return null;
}
