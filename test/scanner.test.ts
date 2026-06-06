import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanManifest } from "../src/scanner/manifest.js";
import { scanEntryPoints } from "../src/scanner/entry-points.js";
import { scanFolderTree } from "../src/scanner/folder-tree.js";
import { scanTooling } from "../src/scanner/tooling.js";
import { scanReadme } from "../src/scanner/readme.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-scan-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanManifest", () => {
  it("parses package.json", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-app",
        version: "1.0.0",
        dependencies: { express: "^4.18.0" },
        devDependencies: { vitest: "^3.0.0" },
        scripts: { build: "tsc", test: "vitest" },
      })
    );
    const result = scanManifest(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("package.json");
    expect(result!.name).toBe("my-app");
    expect(result!.dependencies).toHaveProperty("express");
    expect(result!.scripts).toHaveProperty("build");
  });

  it("returns null when no manifest exists", () => {
    expect(scanManifest(tmpDir)).toBeNull();
  });
});

describe("scanEntryPoints", () => {
  it("finds src/index.ts as main entry", () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), "");
    const entries = scanEntryPoints(tmpDir);
    expect(entries.some((e) => e.path === "src/index.ts" && e.type === "main")).toBe(true);
  });

  it("finds config files", () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    const entries = scanEntryPoints(tmpDir);
    expect(entries.some((e) => e.path === "tsconfig.json" && e.type === "config")).toBe(true);
  });

  it("returns empty for empty project", () => {
    expect(scanEntryPoints(tmpDir)).toEqual([]);
  });
});

describe("scanFolderTree", () => {
  it("categorizes known directory names", () => {
    mkdirSync(join(tmpDir, "routes"));
    mkdirSync(join(tmpDir, "models"));
    mkdirSync(join(tmpDir, "tests"));
    mkdirSync(join(tmpDir, "utils"));

    const tree = scanFolderTree(tmpDir);
    const names = tree.map((t) => t.category);
    expect(names).toContain("routes");
    expect(names).toContain("models");
    expect(names).toContain("tests");
    expect(names).toContain("utils");
  });

  it("ignores node_modules and .git", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    mkdirSync(join(tmpDir, ".git"));
    mkdirSync(join(tmpDir, "src"));

    const tree = scanFolderTree(tmpDir);
    const names = tree.map((t) => t.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).toContain("src");
  });
});

describe("scanTooling", () => {
  it("detects vitest", () => {
    writeFileSync(join(tmpDir, "vitest.config.ts"), "");
    const tooling = scanTooling(tmpDir);
    expect(tooling.testRunner).toBe("vitest");
  });

  it("detects eslint", () => {
    writeFileSync(join(tmpDir, "eslint.config.js"), "");
    const tooling = scanTooling(tmpDir);
    expect(tooling.linter).toBe("eslint");
  });

  it("detects package manager from lock files", () => {
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    const tooling = scanTooling(tmpDir);
    expect(tooling.packageManager).toBe("pnpm");
  });

  it("returns nulls for empty project", () => {
    const tooling = scanTooling(tmpDir);
    expect(tooling.testRunner).toBeNull();
    expect(tooling.buildTool).toBeNull();
    expect(tooling.linter).toBeNull();
    expect(tooling.packageManager).toBeNull();
  });
});

describe("scanReadme", () => {
  it("reads README.md content", () => {
    writeFileSync(join(tmpDir, "README.md"), "# My Project\n\nHello world");
    const result = scanReadme(tmpDir);
    expect(result).toContain("# My Project");
  });

  it("truncates long READMEs", () => {
    writeFileSync(join(tmpDir, "README.md"), "x".repeat(5000));
    const result = scanReadme(tmpDir);
    expect(result!.length).toBeLessThan(5000);
    expect(result).toContain("(truncated)");
  });

  it("returns null when no README exists", () => {
    expect(scanReadme(tmpDir)).toBeNull();
  });
});
