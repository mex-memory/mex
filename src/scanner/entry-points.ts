import { globSync } from "glob";
import type { EntryPoint } from "../types.js";

const MAIN_PATTERNS = [
  "src/index.{ts,js,tsx,jsx}",
  "src/main.{ts,js,tsx,jsx}",
  "src/app.{ts,js,tsx,jsx}",
  "app.{py,rb}",
  "main.{go,py,rs}",
  "index.{ts,js}",
  "server.{ts,js,py}",
  "src/cli.{ts,js}",
  "cmd/*/main.go",
];

const TEST_PATTERNS = [
  "src/**/*.test.{ts,js,tsx,jsx}",
  "src/**/*.spec.{ts,js,tsx,jsx}",
  "tests/**/*.{ts,js,py}",
  "test/**/*.{ts,js,py}",
  "**/*_test.go",
];

const CONFIG_PATTERNS = [
  "tsconfig.json",
  "vite.config.{ts,js}",
  "next.config.{ts,js,mjs}",
  "webpack.config.{ts,js}",
  "jest.config.{ts,js}",
  "vitest.config.{ts,js}",
  ".eslintrc.{js,json,yml}",
  "eslint.config.{js,mjs}",
];

/** Find main entry points, test files, and config files */
export function scanEntryPoints(projectRoot: string): EntryPoint[] {
  const entries: EntryPoint[] = [];
  const seen = new Set<string>();

  const add = (patterns: string[], type: EntryPoint["type"], limit?: number) => {
    let count = 0;
    for (const pattern of patterns) {
      const matches = globSync(pattern, {
        cwd: projectRoot,
        ignore: ["node_modules/**", "dist/**", "build/**", ".git/**"],
      });
      for (const path of matches) {
        if (seen.has(path)) continue;
        seen.add(path);
        entries.push({ path, type });
        count++;
        if (limit && count >= limit) return;
      }
    }
  };

  add(MAIN_PATTERNS, "main");
  add(TEST_PATTERNS, "test", 10); // Cap test files
  add(CONFIG_PATTERNS, "config");

  return entries;
}
