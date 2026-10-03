import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPatternAdd } from "../src/pattern/index.js";
import { parseWikiMarkdown } from "../src/wiki/markdown/codec.js";
import { inventoryScaffold } from "../src/wiki/migration/inventory.js";
import { findAdoptionGaps } from "../src/wiki/migration/adoption-gaps.js";

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

describe("runPatternAdd and the Wiki (#227)", () => {
  const conventions = "---\nname: conventions\nmex:\n  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n  type: convention\n"
    + "  status: promoted\n  revision: 1\n  title: conventions\n---\n\n# Conventions\n\nProse.\n";

  function entitiesOf(path: string) {
    const text = readFileSync(join(tmpDir, path), "utf8");
    return parseWikiMarkdown({ path, text }).entities.map((entry) => entry.entity);
  }

  it("adopts the new pattern when the scaffold already uses the Wiki", async () => {
    mkdirSync(join(tmpDir, "context"));
    writeFileSync(join(tmpDir, "context", "conventions.md"), conventions, "utf8");

    await runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "add-route");

    const [entity] = entitiesOf("patterns/add-route.md");
    expect(entity).toMatchObject({ type: "pattern", title: "add-route", status: "promoted" });
    // The template's edge to the conventions file became a relation too.
    expect(entity?.relations).toEqual([expect.objectContaining({ type: "related_to", target: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD" })]);
    expect(findAdoptionGaps(inventoryScaffold({ scaffoldRoot: tmpDir }))).toEqual([]);
    // Nothing else was touched.
    expect(readFileSync(join(tmpDir, "context", "conventions.md"), "utf8")).toBe(conventions);
  });

  it("leaves the template alone when the scaffold does not use the Wiki", async () => {
    await runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "add-route");
    expect(entitiesOf("patterns/add-route.md")).toEqual([]);
    expect(readFileSync(join(tmpDir, "patterns", "add-route.md"), "utf8")).not.toContain("mex:");
  });

  it("leaves a pattern `wiki.exclude` hides out of the Wiki", async () => {
    mkdirSync(join(tmpDir, "context"));
    writeFileSync(join(tmpDir, "context", "conventions.md"), conventions, "utf8");
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ wiki: { exclude: ["patterns/**"] } }), "utf8");

    await runPatternAdd({ projectRoot: tmpDir, scaffoldRoot: tmpDir }, "add-route");
    expect(entitiesOf("patterns/add-route.md")).toEqual([]);
  });
});
