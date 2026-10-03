import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findAdoptionGaps, wikiInUse } from "../adoption-gaps.js";
import { inventoryScaffold } from "../inventory.js";
import { migrateScaffold } from "../migrate.js";
import { validateScaffold } from "../../validation/validate.js";

const ADOPTED_ARCHITECTURE =
  "---\nname: architecture\nmex:\n  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n  type: architecture\n  status: promoted\n"
  + "  revision: 1\n  title: architecture\n---\n\n# Architecture\n\nProse.\n";

const front = (name: string, keys = "") => `---\nname: ${name}\ndescription: "x"\n${keys}last_updated: 2026-09-21\n---\n\n`;

function scaffoldOf(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-adoption-gaps-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  }
  return root;
}

function gapsOf(root: string) {
  return findAdoptionGaps(inventoryScaffold({ scaffoldRoot: root }));
}

describe("knowledge files outside the Wiki (#227)", () => {
  it("reports nothing for a scaffold that has never been migrated", () => {
    const root = scaffoldOf({
      "context/routing.md": front("routing") + "# Routing\n\nProse.\n",
      "patterns/add-route.md": front("add-route") + "# Add a route\n\nSteps.\n",
    });
    const inventory = inventoryScaffold({ scaffoldRoot: root });
    expect(wikiInUse(inventory)).toBe(false);
    expect(findAdoptionGaps(inventory)).toEqual([]);
  });

  it("reports a pattern added after migration, with the entities migration would create", () => {
    const root = scaffoldOf({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "patterns/add-route.md": front("add-route") + "# Add a route\n\nSteps.\n",
    });
    expect(gapsOf(root)).toEqual([{
      file: "patterns/add-route.md",
      kind: "not-adopted",
      message: "patterns/add-route.md is not in the Wiki: `mex wiki migrate` would adopt it as 1 entity (pattern).",
    }]);
  });

  it("reports a domain context file that declares no type, and one whose declaration migration refuses", () => {
    const root = scaffoldOf({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "context/routing.md": front("routing") + "# Routing\n\nProse.\n",
      "context/payouts.md": front("payouts", "type: requirement\n") + "# Payouts\n\nProse.\n",
    });
    expect(gapsOf(root)).toEqual([
      { file: "context/payouts.md", kind: "invalid-declaration", message: expect.stringContaining("mex inbox") },
      { file: "context/routing.md", kind: "untyped", message: expect.stringContaining("declares no `type`") },
    ]);
  });

  it("does not report untyped files outside `context/`, where nothing says they are knowledge", () => {
    const root = scaffoldOf({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "context/nested/deeper.md": front("deeper") + "# Deeper\n\nProse.\n",
      "notes/scratch.md": front("scratch") + "# Scratch\n\nProse.\n",
    });
    expect(gapsOf(root)).toEqual([]);
  });

  it("never reports navigation, generated or Team-owned files", () => {
    const root = scaffoldOf({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "ROUTER.md": front("router") + "# Router\n\nProse.\n",
      "patterns/INDEX.md": front("index") + "# Pattern Index\n\nProse.\n",
      "patterns/README.md": front("readme") + "# Patterns\n\nProse.\n",
      "relays/relay_01.md": front("relay", "type: relay\n") + "# Relay\n\nProse.\n",
    });
    expect(gapsOf(root)).toEqual([]);
  });

  it("clears an adoptable file once migration runs, and keeps reporting the untyped one", () => {
    const root = scaffoldOf({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "context/stack.md": front("stack") + "# Stack\n\n## Core\n\n- TypeScript\n",
      "context/routing.md": front("routing") + "# Routing\n\nProse.\n",
      "patterns/add-route.md": front("add-route") + "# Add a route\n\nSteps.\n",
    });
    expect(gapsOf(root).map((gap) => [gap.file, gap.kind])).toEqual([
      ["context/routing.md", "untyped"],
      ["context/stack.md", "not-adopted"],
      ["patterns/add-route.md", "not-adopted"],
    ]);
    migrateScaffold({ scaffoldRoot: root });
    expect(gapsOf(root).map((gap) => [gap.file, gap.kind])).toEqual([["context/routing.md", "untyped"]]);
  });

  it("clears an untyped file once its author declares a type and migration runs", () => {
    const root = scaffoldOf({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "context/routing.md": front("routing", "type: component\n") + "# Routing\n\nProse.\n",
    });
    expect(gapsOf(root).map((gap) => gap.kind)).toEqual(["not-adopted"]);
    migrateScaffold({ scaffoldRoot: root });
    expect(gapsOf(root)).toEqual([]);
  });

  it("surfaces through `wiki validate` as warnings with the migration remediation", () => {
    const root = scaffoldOf({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "context/routing.md": front("routing") + "# Routing\n\nProse.\n",
      "patterns/add-route.md": front("add-route") + "# Add a route\n\nSteps.\n",
    });
    const diagnostics = validateScaffold({ scaffoldRoot: root }).diagnostics
      .filter((entry) => entry.code.startsWith("KNOWLEDGE_"));
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "KNOWLEDGE_UNTYPED",
        severity: "warning",
        file: "context/routing.md",
        remediation: expect.stringContaining("root `type` key"),
      }),
      expect.objectContaining({
        code: "KNOWLEDGE_NOT_ADOPTED",
        severity: "warning",
        file: "patterns/add-route.md",
        remediation: expect.stringContaining("mex wiki migrate"),
      }),
    ]);
  });
});
