import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryScaffold } from "../inventory.js";
import { stampScaffoldFiles } from "../stamp.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FACT = [
  "<!-- mex:entity",
  "id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD",
  "type: fact",
  "status: promoted",
  "revision: 1",
  "-->",
  "## Retries back off",
  "Retries double their delay up to a limit.",
  "",
].join("\n");

describe("stamping file-level ids (#286)", () => {
  it("types a placed file by its rule or its declaration, absorbing a declared root type", () => {
    const root = scaffold({
      "context/stack.md": "---\nname: stack\n---\n\n# Stack\n",
      "context/runbook.md": "---\nname: runbook\ntype: guide\n---\n\n# Runbook\n",
      "context/notes.md": "---\nname: notes\n---\n\n# Notes\n",
    });

    const result = stampScaffoldFiles({ scaffoldRoot: root, scope: "placed" });

    expect(result.applied).toBe(true);
    // A placed file nothing types is left alone: only finish falls back to the folder.
    expect(result.stamped).toEqual([
      { file: "context/runbook.md", type: "guide" },
      { file: "context/stack.md", type: "architecture" },
    ]);
    const runbook = readFileSync(join(root, "context", "runbook.md"), "utf8");
    expect(runbook).toMatch(/^mex:\n {2}id: mx_\w+\n {2}type: guide\n/mu);
    expect(runbook).not.toMatch(/^type:/mu);
  });

  it("at finish, stamps only what migration will not adopt", () => {
    const root = scaffold({
      "context/architecture.md": `---\nname: architecture\n---\n\n# Architecture\n\n${FACT}`,
      "context/routing.md": "---\nname: routing\n---\n\n# Routing\n",
      "context/setup.md": "---\nname: setup\n---\n\n# Setup\n",
      "context/risks.md": `---\nname: risks\n---\n\n# Risks\n\n${FACT.replace("BCHJD", "BCHJE")}`,
      "patterns/deploy.md": "---\nname: deploy\n---\n\n# Deploy\n",
      "notes.md": "---\nname: notes\n---\n\n# Notes\n",
      "ROUTER.md": "---\nname: router\n---\n\n# Router\n",
    });

    const result = stampScaffoldFiles({ scaffoldRoot: root, scope: "remaining" });

    // A typed file with no entities (setup.md, the pattern) is migration's,
    // which adopts its sections too; a register (risks) has no file-level
    // entity; a file outside context/ and patterns/ has no folder type.
    expect(result.stamped).toEqual([
      { file: "context/architecture.md", type: "architecture" },
      { file: "context/routing.md", type: "component" },
    ]);
    const parsed = inventoryScaffold({ scaffoldRoot: root }).files.find((file) => file.path === "context/architecture.md")!;
    // The fact keeps its id and its prose; only the file entity is new.
    expect(parsed.parsed.entities.map((entry) => entry.metadataKind)).toEqual(["frontmatter", "comment"]);
    expect(parsed.text).toContain("Retries double their delay up to a limit.");
  });

  it("skips read-only paths and changes nothing when there is nothing to stamp", () => {
    const root = scaffold({ "context/stack.md": "---\nname: stack\n---\n\n# Stack\n" });
    const before = readFileSync(join(root, "context", "stack.md"), "utf8");

    const result = stampScaffoldFiles({ scaffoldRoot: root, scope: "placed", readOnly: ["context/**"] });

    expect(result).toEqual({ stamped: [], applied: true, diagnostics: [] });
    expect(readFileSync(join(root, "context", "stack.md"), "utf8")).toBe(before);
  });
});

function scaffold(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-stamp-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  }
  return root;
}
