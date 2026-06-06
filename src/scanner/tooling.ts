import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolingInfo } from "../types.js";

/** Detect project tooling from config files */
export function scanTooling(projectRoot: string): ToolingInfo {
  return {
    testRunner: detectTestRunner(projectRoot),
    buildTool: detectBuildTool(projectRoot),
    linter: detectLinter(projectRoot),
    formatter: detectFormatter(projectRoot),
    packageManager: detectPackageManager(projectRoot),
  };
}

function exists(root: string, ...files: string[]): boolean {
  return files.some((f) => existsSync(resolve(root, f)));
}

function detectTestRunner(root: string): string | null {
  if (exists(root, "vitest.config.ts", "vitest.config.js")) return "vitest";
  if (exists(root, "jest.config.ts", "jest.config.js", "jest.config.json"))
    return "jest";
  if (exists(root, "pytest.ini", "pyproject.toml")) return "pytest";
  if (exists(root, ".mocharc.yml", ".mocharc.json")) return "mocha";
  return null;
}

function detectBuildTool(root: string): string | null {
  if (exists(root, "tsup.config.ts", "tsup.config.js")) return "tsup";
  if (exists(root, "vite.config.ts", "vite.config.js")) return "vite";
  if (exists(root, "next.config.ts", "next.config.js", "next.config.mjs"))
    return "next";
  if (exists(root, "webpack.config.ts", "webpack.config.js")) return "webpack";
  if (exists(root, "rollup.config.ts", "rollup.config.js")) return "rollup";
  if (exists(root, "esbuild.config.ts")) return "esbuild";
  if (exists(root, "Makefile")) return "make";
  return null;
}

function detectLinter(root: string): string | null {
  if (
    exists(
      root,
      "eslint.config.js",
      "eslint.config.mjs",
      ".eslintrc.js",
      ".eslintrc.json",
      ".eslintrc.yml"
    )
  )
    return "eslint";
  if (exists(root, ".pylintrc", "pylintrc")) return "pylint";
  if (exists(root, ".flake8")) return "flake8";
  if (exists(root, ".golangci.yml")) return "golangci-lint";
  return null;
}

function detectFormatter(root: string): string | null {
  if (exists(root, ".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js"))
    return "prettier";
  if (exists(root, "biome.json")) return "biome";
  if (exists(root, ".editorconfig")) return "editorconfig";
  return null;
}

function detectPackageManager(
  root: string
): ToolingInfo["packageManager"] {
  if (exists(root, "bun.lockb", "bun.lock")) return "bun";
  if (exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (exists(root, "yarn.lock")) return "yarn";
  if (exists(root, "package-lock.json")) return "npm";
  if (exists(root, "package.json")) return "npm"; // default
  return null;
}
