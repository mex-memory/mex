import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDriftCheck } from "../src/drift/index.js";
import { checkWikiAdoption } from "../src/drift/checkers/wiki-adoption.js";
import { computeScore } from "../src/drift/scoring.js";
import type { MexConfig } from "../src/types.js";

const ADOPTED_ARCHITECTURE =
  "---\nname: architecture\ndescription: \"x\"\nlast_updated: 2026-09-21\nmex:\n  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n"
  + "  type: architecture\n  status: promoted\n  revision: 1\n  title: architecture\n---\n\n# Architecture\n\nProse.\n";

const front = (name: string, keys = "") => `---\nname: ${name}\ndescription: "x"\n${keys}last_updated: 2026-09-21\n---\n\n`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): MexConfig {
  const projectRoot = mkdtempSync(join(tmpdir(), "mex-adoption-check-"));
  roots.push(projectRoot);
  const scaffoldRoot = join(projectRoot, ".mex");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(scaffoldRoot, path)), { recursive: true });
    writeFileSync(join(scaffoldRoot, path), text, "utf8");
  }
  return { projectRoot, scaffoldRoot, aiTools: [] };
}

describe("mex check reports knowledge outside the Wiki (#227)", () => {
  it("names a pattern added after migration and an untyped context file, by project path", () => {
    const config = project({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "context/routing.md": front("routing") + "# Routing\n\nProse.\n",
      "patterns/add-route.md": front("add-route") + "# Add a route\n\nSteps.\n",
    });
    expect(checkWikiAdoption(config.projectRoot, config.scaffoldRoot)).toEqual([
      expect.objectContaining({ code: "KNOWLEDGE_UNTYPED", severity: "warning", file: ".mex/context/routing.md", line: null }),
      expect.objectContaining({ code: "KNOWLEDGE_NOT_ADOPTED", severity: "warning", file: ".mex/patterns/add-route.md", line: null }),
    ]);
  });

  it("runs as part of the drift check, and the findings cost score", async () => {
    const config = project({
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "patterns/add-route.md": front("add-route") + "# Add a route\n\nSteps.\n",
    });
    const report = await runDriftCheck(config);
    const adoption = report.issues.filter((issue) => issue.code.startsWith("KNOWLEDGE_"));
    expect(adoption.map((issue) => issue.code)).toEqual(["KNOWLEDGE_NOT_ADOPTED"]);
    expect(computeScore(adoption)).toBe(97);
  });

  it("is silent for a scaffold that has never been migrated", () => {
    const config = project({
      "context/routing.md": front("routing") + "# Routing\n\nProse.\n",
      "patterns/add-route.md": front("add-route") + "# Add a route\n\nSteps.\n",
    });
    expect(checkWikiAdoption(config.projectRoot, config.scaffoldRoot)).toEqual([]);
  });

  it("honours `wiki.exclude`, the walk the Wiki itself uses", () => {
    const config = project({
      "config.json": JSON.stringify({ wiki: { exclude: ["patterns/drafts/**"] } }),
      "context/architecture.md": ADOPTED_ARCHITECTURE,
      "patterns/drafts/half-written.md": front("half-written") + "# Half written\n\nSteps.\n",
    });
    expect(checkWikiAdoption(config.projectRoot, config.scaffoldRoot)).toEqual([]);
  });

  it("is silent when there is no scaffold to walk", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mex-adoption-check-"));
    roots.push(projectRoot);
    expect(checkWikiAdoption(projectRoot, join(projectRoot, ".mex"))).toEqual([]);
  });
});
