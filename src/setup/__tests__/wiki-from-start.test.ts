import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryScaffold } from "../../wiki/migration/inventory.js";
import { createWikiEngine } from "../../wiki/service.js";
import { SCAFFOLD_FILES, setupTemplatesDirectory } from "../phases.js";
import { finalizeSetupWiki } from "../wiki-finalize.js";
import { stampPlacedTemplates } from "../wiki-stamp.js";

const roots: string[] = [];
const templatesDir = setupTemplatesDirectory();
const KNOWLEDGE = ["context/architecture.md", "context/stack.md", "context/conventions.md", "context/setup.md"];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can briefly retain a just-closed SQLite handle.
    }
  }
});

describe("a Wiki from the start (#286)", () => {
  it("stamps placed templates, keeps facts linked, and finishes without migration notices", async () => {
    const { projectRoot, mexDir } = placedScaffold();
    const placementWarnings: string[] = [];
    await stampPlacedTemplates(projectRoot, mexDir, templatesDir, (message) => placementWarnings.push(message));

    expect(placementWarnings).toEqual([]);
    for (const file of KNOWLEDGE) expect(read(mexDir, file), file).toMatch(/^mex:\r?\n {2}id: mx_\w+/mu);
    // Navigation gets no entity, and the decision log waits for its entries.
    expect(read(mexDir, "ROUTER.md")).not.toMatch(/^mex:/mu);
    expect(read(mexDir, "context/decisions.md")).not.toMatch(/^mex:/mu);

    // Population: a fact the agent forgot to link, one it linked by the file's
    // id, and a decision written by hand into the log.
    const architectureId = fileEntityId(mexDir, "context/architecture.md");
    const stackId = fileEntityId(mexDir, "context/stack.md");
    await createFact(mexDir, "context/architecture.md", "fact_unlinked", "Requests pass the router first");
    await createFact(mexDir, "context/stack.md", "fact_linked", "The index is SQLite", stackId);
    appendFileSync(join(mexDir, "context", "decisions.md"), [
      "",
      "### Keep the index in SQLite",
      "**Date:** 2026-10-25",
      "**Status:** Active",
      "**Decision:** The Wiki index stays a single SQLite file.",
      "**Reasoning:** One file, no server, rebuilt from Markdown at any time.",
      "",
    ].join("\n"));
    // A fact in the log must not make finalize skip its authored decisions.
    await createFact(mexDir, "context/decisions.md", "decision_fact", "The log retains decisions");

    const warnings: string[] = [];
    const result = await finalizeSetupWiki({ projectRoot, scaffoldRoot: mexDir, onWarning: (message) => warnings.push(message) });

    expect(result).toMatchObject({ ready: true, stage: "complete", abstentions: 0 });
    expect(warnings).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain("AMBIGUOUS_MIGRATION");
    expect(result.diagnostics.filter((entry) => entry.code === "ORPHANED_ENTITY").map((entry) => entry.message)).toEqual([]);

    const entities = inventoryScaffold({ scaffoldRoot: mexDir }).files.flatMap((file) =>
      file.parsed.entities.map((entry) => ({ file: file.path, kind: entry.metadataKind, ...entry.entity })));
    // Every knowledge file, the decision log included, now has its own entity.
    for (const file of [...KNOWLEDGE, "context/decisions.md"]) {
      expect(entities.filter((entity) => entity.file === file && entity.kind === "frontmatter"), file).toHaveLength(1);
    }
    expect(fileEntityId(mexDir, "context/architecture.md")).toBe(architectureId);
    const decisionsId = fileEntityId(mexDir, "context/decisions.md");
    const refinesOf = (title: string) =>
      entities.find((entity) => entity.title === title)?.relations.filter((relation) => relation.type === "refines").map((relation) => relation.target);
    expect(refinesOf("Requests pass the router first")).toEqual([architectureId]);
    expect(refinesOf("The index is SQLite")).toEqual([stackId]);
    const decision = entities.find((entity) => entity.title === "Keep the index in SQLite");
    expect(decision?.type).toBe("decision");
    expect(refinesOf("Keep the index in SQLite")).toEqual([decisionsId]);
    expect(refinesOf("The log retains decisions")).toEqual([decisionsId]);
    // The architecture template's edge to the decision log now resolves.
    const architecture = entities.find((entity) => entity.id === architectureId);
    expect(architecture?.relations.map((relation) => relation.target)).toContain(decisionsId);
  }, 60_000);

  it("stamps templates an interrupted run left pristine, and leaves authored ones for finish", async () => {
    const { projectRoot, mexDir } = placedScaffold();
    writeFileSync(join(mexDir, "context", "conventions.md"), `${read(mexDir, "context/conventions.md")}\nUse tabs.\n`);

    await stampPlacedTemplates(projectRoot, mexDir, templatesDir, () => {});

    expect(read(mexDir, "context/architecture.md")).toMatch(/^mex:/mu);
    expect(read(mexDir, "context/conventions.md")).not.toMatch(/^mex:/mu);
    // A rerun changes nothing further: the stamped files are no longer pristine.
    const before = read(mexDir, "context/architecture.md");
    await stampPlacedTemplates(projectRoot, mexDir, templatesDir, () => {});
    expect(read(mexDir, "context/architecture.md")).toBe(before);
  });

  it("gives a file that only holds facts its own id at finish, and links the facts to it", async () => {
    const projectRoot = fixture();
    const mexDir = join(projectRoot, ".mex");
    mkdirSync(join(mexDir, "context"), { recursive: true });
    writeFileSync(join(mexDir, "context", "architecture.md"),
      "---\nname: architecture\ndescription: How the pieces connect.\n---\n\n# Architecture\n\nBroad prose.\n");
    // Emulate a legacy facts-only file; current create-entry stamps its parent.
    appendFileSync(join(mexDir, "context", "architecture.md"), [
      "", "<!-- mex:entity", "id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD", "type: fact",
      "status: promoted", "revision: 1", "-->", "## Workers drain the queue", "",
      "Workers drain the queue, as the code shows.", "",
    ].join("\n"));

    const warnings: string[] = [];
    const result = await finalizeSetupWiki({ projectRoot, scaffoldRoot: mexDir, onWarning: (message) => warnings.push(message) });

    expect(result).toMatchObject({ ready: true, stampedFiles: 1, linkedSections: 1 });
    expect(warnings).toEqual([]);
    const fileId = fileEntityId(mexDir, "context/architecture.md");
    const fact = inventoryScaffold({ scaffoldRoot: mexDir }).files
      .flatMap((file) => file.parsed.entities)
      .find((entry) => entry.entity.title === "Workers drain the queue");
    expect(fact?.entity.relations).toEqual([expect.objectContaining({ type: "refines", target: fileId })]);
  });

});

function placedScaffold(): { projectRoot: string; mexDir: string } {
  const projectRoot = fixture();
  const mexDir = join(projectRoot, ".mex");
  for (const file of SCAFFOLD_FILES) {
    mkdirSync(dirname(join(mexDir, file)), { recursive: true });
    copyFileSync(join(templatesDir, file), join(mexDir, file));
  }
  return { projectRoot, mexDir };
}

async function createFact(mexDir: string, file: string, opId: string, title: string, parent?: string): Promise<void> {
  const result = await createWikiEngine({ scaffoldRoot: mexDir }).applyOperation({
    opId,
    type: "create-entry",
    actor: { kind: "agent", id: "test" },
    timestamp: "2026-10-25T00:00:00.000Z",
    reason: "one entity per code-linked claim",
    payload: {
      file,
      insertAt: { at: "end-of-file" },
      type: "fact",
      title,
      body: `${title}, as the code shows.`,
      headingDepth: 2,
      status: "promoted",
      ...(parent === undefined ? {} : { relations: [{ type: "refines", target: parent }] }),
    },
  }, { apply: true });
  expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
}

function fileEntityId(mexDir: string, file: string): string {
  const entry = inventoryScaffold({ scaffoldRoot: mexDir }).files
    .find((candidate) => candidate.path === file)?.parsed.entities
    .find((candidate) => candidate.metadataKind === "frontmatter");
  if (entry === undefined) throw new Error(`${file} has no file-level entity`);
  return entry.entity.id;
}

function read(mexDir: string, file: string): string {
  return readFileSync(join(mexDir, file), "utf8");
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-from-start-"));
  roots.push(root);
  return root;
}
