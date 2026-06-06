import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPatternAdd } from "../src/pattern/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-pattern-"));
  mkdirSync(join(tmpDir, "patterns"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runPatternAdd", () => {
  it("creates a new pattern file and index entry", async () => {
    writeFileSync(join(tmpDir, "patterns", "INDEX.md"), "| Pattern | Use when |\n|---|---|\n", "utf8");

    await runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "my-pattern");

    const patternContent = readFileSync(join(tmpDir, "patterns", "my-pattern.md"), "utf8");
    expect(patternContent).toContain("name: my-pattern");
    expect(patternContent).toContain("# my-pattern");
    expect(patternContent).toContain("## Verify");

    const indexContent = readFileSync(join(tmpDir, "patterns", "INDEX.md"), "utf8");
    expect(indexContent).toContain("| [my-pattern.md](my-pattern.md) |");
  });

  it("throws an error if pattern already exists", async () => {
    writeFileSync(join(tmpDir, "patterns", "my-pattern.md"), "existing content", "utf8");

    await expect(
      runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "my-pattern")
    ).rejects.toThrow("already exists");
  });

  it("creates pattern even if INDEX.md is missing", async () => {
    await runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "my-pattern");

    const patternContent = readFileSync(join(tmpDir, "patterns", "my-pattern.md"), "utf8");
    expect(patternContent).toContain("name: my-pattern");
  });

  it("throws an error for invalid pattern names", async () => {
    await expect(
      runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "my pattern")
    ).rejects.toThrow("Invalid pattern name");

    await expect(
      runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "pattern!")
    ).rejects.toThrow("Invalid pattern name");
  });

  it("appends to INDEX.md with a newline if it does not end with one", async () => {
    writeFileSync(join(tmpDir, "patterns", "INDEX.md"), "| Pattern | Use when |", "utf8");

    await runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "newline-pattern");

    const indexContent = readFileSync(join(tmpDir, "patterns", "INDEX.md"), "utf8");
    expect(indexContent).toBe("| Pattern | Use when |\n| [newline-pattern.md](newline-pattern.md) | [description] |\n");
  });
});
