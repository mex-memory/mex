import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGroundingCoverage } from "../src/ui/grounding.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-ui-grounding-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeScaffold(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ".mex", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}

describe("readGroundingCoverage — counting authored references", () => {
  it("returns an empty, actionless payload when there is no scaffold", () => {
    expect(readGroundingCoverage({ root })).toEqual({
      graphAvailable: false,
      authored: 0,
      captured: 0,
      needsCapture: false,
      files: [],
      error: null,
    });
  });

  it("ignores scaffold files that reference nothing", () => {
    writeScaffold({
      "ROUTER.md": "# Router\n",
      "context/stack.md": "---\nname: stack\ngrounds_to: []\n---\n\n# Stack\n\nProse only.\n",
    });

    const coverage = readGroundingCoverage({ root });
    expect(coverage.authored).toBe(0);
    expect(coverage.files).toEqual([]);
  });

  it("counts both grounds_to entries and mex:// anchors", () => {
    writeScaffold({
      "context/architecture.md": [
        "---",
        "name: architecture",
        "grounds_to:",
        '  - node: "function:aaa"',
        '    fingerprint: "mh:64:00"',
        "---",
        "",
        "Flow starts at [`start()`](mex://function:bbb).",
        "",
      ].join("\n"),
    });

    const coverage = readGroundingCoverage({ root });
    expect(coverage.authored).toBe(2);
    expect(coverage.files).toEqual([
      { file: ".mex/context/architecture.md", authored: 2, captured: 0 },
    ]);
  });

  it("counts a node referenced by both an entry and an anchor once", () => {
    writeScaffold({
      "context/architecture.md": [
        "---",
        "name: architecture",
        "grounds_to:",
        '  - node: "function:aaa"',
        '    fingerprint: "mh:64:00"',
        "---",
        "",
        "Flow starts at [`start()`](mex://function:aaa).",
        "",
      ].join("\n"),
    });

    expect(readGroundingCoverage({ root }).authored).toBe(1);
  });

  it("reports authored references without a graph, and asks for no capture", () => {
    writeScaffold({
      "context/stack.md": "# Stack\n\nSee [`run()`](mex://function:aaa).\n",
    });

    const coverage = readGroundingCoverage({ root });
    expect(coverage.graphAvailable).toBe(false);
    expect(coverage.authored).toBe(1);
    // Capture can't be the recommendation when there is nothing to fingerprint
    // against — building the graph is.
    expect(coverage.needsCapture).toBe(false);
  });

  it("surfaces an unreadable graph as an error rather than throwing", () => {
    writeScaffold({
      "context/stack.md": "# Stack\n\nSee [`run()`](mex://function:aaa).\n",
      "graph.db": "this is not a sqlite database",
    });

    const coverage = readGroundingCoverage({ root });
    expect(coverage.error).toBeTruthy();
    expect(coverage.graphAvailable).toBe(false);
    expect(coverage.authored).toBe(1);
  });
});
