import { describe, it, expect } from "vitest";
import {
  parseMarkdown,
  extractFrontmatter,
  getHeadingAtLine,
  isNegatedSection,
} from "../src/markdown.js";

describe("parseMarkdown", () => {
  it("parses basic markdown into AST", () => {
    const tree = parseMarkdown("# Hello\n\nSome text");
    expect(tree.type).toBe("root");
    expect(tree.children.length).toBeGreaterThan(0);
    expect(tree.children[0].type).toBe("heading");
  });
});

describe("extractFrontmatter", () => {
  it("extracts YAML frontmatter", () => {
    const md = `---
name: test
description: a test file
edges:
  - target: context/foo.md
    condition: when doing foo
---

# Content`;
    const fm = extractFrontmatter(md);
    expect(fm).not.toBeNull();
    expect(fm!.name).toBe("test");
    expect(fm!.description).toBe("a test file");
    expect(fm!.edges).toHaveLength(1);
    expect(fm!.edges![0].target).toBe("context/foo.md");
  });

  it("returns null for no frontmatter", () => {
    expect(extractFrontmatter("# Just a heading")).toBeNull();
  });

  it("returns null for invalid YAML", () => {
    const md = `---
: broken: yaml: [
---`;
    expect(extractFrontmatter(md)).toBeNull();
  });
});

describe("getHeadingAtLine", () => {
  it("returns the heading active at a given line", () => {
    const tree = parseMarkdown(`# First

Some text

## Second

More text
`);
    expect(getHeadingAtLine(tree, 1)).toBe("First");
    expect(getHeadingAtLine(tree, 3)).toBe("First");
    expect(getHeadingAtLine(tree, 5)).toBe("Second");
    expect(getHeadingAtLine(tree, 7)).toBe("Second");
  });

  it("returns null before any heading", () => {
    const tree = parseMarkdown("No heading here\n\n# Late heading");
    expect(getHeadingAtLine(tree, 1)).toBeNull();
  });
});

describe("isNegatedSection", () => {
  it("detects negated headings", () => {
    expect(isNegatedSection("What Does NOT Exist")).toBe(true);
    expect(isNegatedSection("Deliberately NOT Use")).toBe(true);
    expect(isNegatedSection("Excluded Libraries")).toBe(true);
    expect(isNegatedSection("Removed Features")).toBe(true);
    expect(isNegatedSection("Deprecated APIs")).toBe(true);
  });

  it("does not flag normal headings", () => {
    expect(isNegatedSection("Key Libraries")).toBe(false);
    expect(isNegatedSection("Architecture")).toBe(false);
    expect(isNegatedSection(null)).toBe(false);
  });
});
