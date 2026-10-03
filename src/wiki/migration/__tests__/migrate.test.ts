/**
 * Section 20.6 — migration over the whole tier-1 corpus.
 *
 * The property that matters most is insertion-only with respect to prose, and
 * it is asserted as a property over every file rather than by inspecting a
 * couple of them. The trap that shape invites is a corpus nothing was written
 * to: strip metadata from an untouched file and the remainder is trivially
 * identical. So the entity count is asserted in the same test.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrateScaffold, planMigration, renderMigrationReport, type MigrationReport } from "../migrate.js";
import { inventoryScaffold } from "../inventory.js";
import { migrationOpId, opIdForCandidate, anchorOf } from "../ids.js";
import { classifyFile, orderForAdoption } from "../classify.js";
import { parseWikiMarkdown } from "../../markdown/codec.js";
import { readAuditLog, acceptedOperations, operationLogPath } from "../../operations/audit.js";
import { applyOperation } from "../../operations/apply.js";
import { isEntityId } from "../../model/ids.js";

/**
 * A migration of the twenty-five-file corpus is roughly three seconds of real
 * work, so a test that runs two of them does not fit vitest's five-second
 * default — which is a statement about unit tests, not about integration ones.
 *
 * Stated as an explicit timeout rather than a suite-wide flag, for the reason
 * P6 made its `beforeAll` hooks explicit: a hook that outran the default marked
 * its whole suite *skipped* rather than failed, and six tests disappeared from
 * a green run. A number written beside the test that needs it is visible; a
 * flag on an invocation is not, and it silently loosens every other test too.
 */
const TWO_MIGRATIONS = { timeout: 30_000 };

const TIER1 = resolve(__dirname, "..", "..", "..", "..", "test", "fixtures", "wiki-migration", "tier1");

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "mig-run-"));
  cpSync(TIER1, root, { recursive: true });
  return root;
}

/**
 * A file's prose: everything that is not frontmatter and not a metadata block.
 *
 * This is the comparison HARD 1 is stated in. Frontmatter is excluded because
 * a file-level entity's metadata *is* a frontmatter key; comment blocks are
 * excluded because they are the metadata migration inserts. Every other byte
 * has to survive.
 */
function proseOf(text: string): string {
  const withoutFrontmatter = text.startsWith("---") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
  return withoutFrontmatter.replace(/<!-- mex:entity[\s\S]*?-->\r?\n?/g, "");
}

function allProse(root: string): Map<string, string> {
  const prose = new Map<string, string>();
  for (const file of inventoryScaffold({ scaffoldRoot: root }).files) prose.set(file.path, proseOf(file.text));
  return prose;
}

describe("migrating the tier-1 corpus", () => {
  let root: string;
  let before: Map<string, string>;
  let report: MigrationReport;

  beforeAll(() => {
    root = scaffold();
    before = allProse(root);
    report = migrateScaffold({ scaffoldRoot: root });
    // An explicit hook timeout, because vitest reports a timed-out `beforeAll`
    // by marking every test in the suite **skipped** rather than failed — so a
    // whole describe block can disappear from a green run without a word.
  }, 180_000);

  it("creates the entities the classifier proposed, and reports no error", () => {
    const errors = report.diagnostics.filter((entry) => entry.severity === "error");
    expect(errors.map((entry) => `${entry.code}: ${entry.message}`)).toEqual([]);
    expect(report.idsGenerated.length).toBe(43);
    expect(report.idsGenerated.every((id) => isEntityId(id))).toBe(true);
    expect(new Set(report.idsGenerated).size).toBe(43);
  });

  it("leaves every character of prose byte-identical", () => {
    const after = allProse(root);
    // Not a vacuous comparison: the run above created 43 entities across these
    // files, so the metadata blocks being stripped are real.
    expect(report.idsGenerated.length).toBeGreaterThan(0);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, text] of before) {
      expect(after.get(path), `prose changed in ${path}`).toBe(text);
    }
  });

  it("puts a `mex:` key or a comment block where the classifier said, and nowhere else", () => {
    const inventory = inventoryScaffold({ scaffoldRoot: root });
    const entities = inventory.files.flatMap((file) => file.parsed.entities);
    expect(entities.length).toBe(43);
    // Parsing the migrated tree produces no diagnostic at all: the metadata
    // migration wrote is metadata the codec reads back.
    expect(inventory.files.flatMap((file) => file.parsed.diagnostics)).toEqual([]);
  });

  it("converts an edge only when both ends resolve, and reports the rest", () => {
    expect(report.edgesConverted).toBeGreaterThan(0);
    expect(report.edgesAmbiguous).toBeGreaterThan(0);
    const ambiguous = report.diagnostics.filter((entry) => entry.code === "AMBIGUOUS_MIGRATION");
    expect(ambiguous.length).toBe(report.edgesAmbiguous + report.groundingsAmbiguous);

    // The condition became the note, on a real converted edge.
    const conventions = readFileSync(join(root, "context", "conventions.md"), "utf-8");
    expect(conventions).toMatch(/type: related_to/);
    expect(conventions).toMatch(/note:/);
  });

  it("keeps the root `edges` key exactly as it was", () => {
    // Shipped infrastructure reads it: the drift checkers walk it and call it
    // canonical navigation. Conversion is additive.
    for (const [path, text] of before) {
      const now = readFileSync(join(root, path), "utf-8");
      const edgesBlock = /^edges:\n(?:[ ]{2,}.*\n)+/m;
      const original = edgesBlock.exec(readFileSync(join(TIER1, path), "utf-8"))?.[0];
      if (original === undefined) continue;
      expect(now, `${path} lost or rewrote its root edges`).toContain(original);
    }
  });

  it("is a no-op the second time, with no new ids and no new log lines", () => {
    const log = readAuditLog(root);
    const acceptedBefore = acceptedOperations(log).length;
    const textBefore = new Map(
      inventoryScaffold({ scaffoldRoot: root }).files.map((file) => [file.path, file.text]),
    );

    const second = migrateScaffold({ scaffoldRoot: root });
    expect(second.idsGenerated).toEqual([]);

    const acceptedAfter = acceptedOperations(readAuditLog(root)).length;
    expect(acceptedAfter).toBe(acceptedBefore);
    for (const file of inventoryScaffold({ scaffoldRoot: root }).files) {
      expect(file.text, `${file.path} changed on a second run`).toBe(textBefore.get(file.path));
    }
  });
});

describe("the dry run", () => {
  it("writes nothing at all, and mints no id", () => {
    const root = scaffold();
    const textBefore = new Map(
      inventoryScaffold({ scaffoldRoot: root }).files.map((file) => [file.path, file.text]),
    );

    const report = planMigration({ scaffoldRoot: root });
    expect(report.dryRun).toBe(true);
    expect(report.planned.length).toBe(43);
    expect(report.idsGenerated).toEqual([]);

    // Asserted against the log's *contents*, not its existence.
    expect(existsSync(operationLogPath(root))).toBe(false);
    for (const file of inventoryScaffold({ scaffoldRoot: root }).files) {
      expect(file.text, `${file.path} changed during a dry run`).toBe(textBefore.get(file.path));
    }
    // And the report names where each entity would go, without promising an id.
    expect(report.planned.every((entry) => entry.location !== "")).toBe(true);
    expect(JSON.stringify(report.planned)).not.toMatch(/mx_[0-9A-HJKMNP-TV-Z]{26}/);
  });

  it("reports the ambiguity an apply would produce, before anything is written", TWO_MIGRATIONS, () => {
    const root = scaffold();
    const dry = planMigration({ scaffoldRoot: root });
    const wet = migrateScaffold({ scaffoldRoot: root });
    expect(dry.edgesAmbiguous).toBe(wet.edgesAmbiguous);
    expect(dry.groundingsAmbiguous).toBe(wet.groundingsAmbiguous);
    expect(dry.planned.length).toBe(wet.planned.length);
    // The half this test was named for was the half that was right. It compared
    // the two ambiguity counts and the plan size, and never `edgesConverted` —
    // which was 0 on every dry run of this corpus and 23 on every apply of it,
    // for four phases, with this test green throughout.
    expect(dry.edgesConverted).toBe(wet.edgesConverted);
  });

  it("says why it minted no ids, instead of leaving a reader to work it out", () => {
    // `entities proposed: 29` above `ids generated: 0` is not a contradiction —
    // section 13.3 mints on apply — but it reads as one, and it cost a reader a
    // source dive. Presentation only: the number is untouched.
    const root = scaffold();
    const rendered = renderMigrationReport(planMigration({ scaffoldRoot: root }));
    expect(rendered).toContain("Migration dry run");
    expect(rendered).toMatch(/ids generated: {6}0 \(a dry run mints none; ids are generated on apply\)/);
    rmSync(root, { recursive: true, force: true });
  });

  it("counts a converted edge rather than mistaking it for a self-edge", () => {
    // Two files that each gain a file-level entity, one edging to the other.
    // Every projected entity used to share a single placeholder id, so
    // `planLegacyEdges`'s self-edge guard — `target === source`, which is there
    // for a file that edges to itself — fired on this edge and returned early:
    // not converted, and not reported either. The narrowest scaffold that
    // provokes it, so a failure names the mechanism rather than a corpus count.
    const root = mkdtempSync(join(tmpdir(), "mig-dry-edge-"));
    mkdirSync(join(root, "patterns"), { recursive: true });
    writeFileSync(
      join(root, "patterns", "a.md"),
      ["---", "name: a", "edges:", "  - target: patterns/b.md", "    condition: when b matters", "---", "", "# A", "", "Prose.", ""].join("\n"),
    );
    writeFileSync(
      join(root, "patterns", "b.md"),
      ["---", "name: b", "---", "", "# B", "", "Prose.", ""].join("\n"),
    );

    const dry = planMigration({ scaffoldRoot: root });
    expect(dry.planned.length).toBe(2);
    expect(dry.edgesConverted).toBe(1);
    expect(dry.edgesAmbiguous).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("opIds", () => {
  it("are derived from the work, so a re-run recomputes them", TWO_MIGRATIONS, () => {
    const root = scaffold();
    const first = inventoryScaffold({ scaffoldRoot: root });
    const idsBefore = first.files.flatMap((file) =>
      orderForAdoption(classifyFile(file).candidates).map((candidate) => opIdForCandidate(file, candidate)),
    );
    expect(idsBefore.length).toBe(43);
    expect(new Set(idsBefore).size).toBe(43);

    migrateScaffold({ scaffoldRoot: root });

    // Recomputed against the *migrated* tree, where bytes have been inserted
    // above later headings. The anchor has to survive that, and a byte offset
    // would not.
    const second = inventoryScaffold({ scaffoldRoot: root });
    const accepted = new Set(acceptedOperations(readAuditLog(root)).map((entry) => entry.opId));
    for (const opId of idsBefore) {
      expect(accepted.has(opId), `${opId} has no completion line after the run`).toBe(true);
    }
    expect(second.files.length).toBe(first.files.length);
  });

  it("distinguish two headings that read the same in one file", () => {
    const text = "---\nname: architecture\n---\n\n# A\n\n## Verify\n\none\n\n## Verify\n\ntwo\n";
    const file = {
      path: "context/architecture.md",
      absolutePath: "context/architecture.md",
      text,
      parsed: parseWikiMarkdown({ path: "context/architecture.md", text }),
      headings: [
        { depth: 1, start: 0, end: 0, title: "A" },
        { depth: 2, start: 1, end: 1, title: "Verify" },
        { depth: 2, start: 2, end: 2, title: "Verify" },
      ],
    };
    const first = anchorOf(file, { at: "heading", ordinal: 1, text: "Verify", depth: 2, start: 1 });
    const second = anchorOf(file, { at: "heading", ordinal: 2, text: "Verify", depth: 2, start: 2 });
    expect(first).not.toBe(second);
    expect(migrationOpId("create-entry", file.path, first)).not.toBe(
      migrationOpId("create-entry", file.path, second),
    );
  });

  it("are stable across two computations of the same work", () => {
    expect(migrationOpId("create-entry", "context/a.md", "h:0:One")).toBe(
      migrationOpId("create-entry", "context/a.md", "h:0:One"),
    );
    expect(migrationOpId("create-entry", "context/a.md", "h:0:One")).not.toBe(
      migrationOpId("add-relation", "context/a.md", "h:0:One"),
    );
  });
});

describe("restartability", () => {
  it("completes cleanly after a crash mid-apply, with no duplicate id", TWO_MIGRATIONS, () => {
    const root = scaffold();
    let written = 0;
    expect(() =>
      migrateScaffold({
        scaffoldRoot: root,
        onFileWritten: () => {
          written += 1;
          // Kill the run after the fifth file reaches disk. This is the state a
          // real crash leaves: bytes written, no completion line for the
          // operation that wrote them.
          if (written === 5) throw new Error("staged crash");
        },
      }),
    ).toThrow("staged crash");

    const interrupted = inventoryScaffold({ scaffoldRoot: root });
    expect(interrupted.files.flatMap((file) => file.parsed.entities).length).toBeGreaterThan(0);

    const resumed = migrateScaffold({ scaffoldRoot: root });
    const errors = resumed.diagnostics.filter((entry) => entry.severity === "error");
    expect(errors.map((entry) => entry.message)).toEqual([]);

    const after = inventoryScaffold({ scaffoldRoot: root });
    const ids = after.files.flatMap((file) => file.parsed.entities.map((entry) => entry.entity.id));
    expect(ids.length).toBe(43);
    expect(new Set(ids).size, "a resumed run minted a second entity for the same prose").toBe(43);
    expect(after.files.flatMap((file) => file.parsed.diagnostics)).toEqual([]);

    // And the prose is still untouched after a crash and a resume.
    const prose = allProse(root);
    for (const file of inventoryScaffold({ scaffoldRoot: TIER1 }).files) {
      expect(prose.get(file.path), `prose changed in ${file.path}`).toBe(proseOf(file.text));
    }
  });
});

describe("wiki.readOnly", () => {
  it("refuses to migrate a reserved path", () => {
    const root = scaffold();
    const report = migrateScaffold({ scaffoldRoot: root, readOnly: ["context/**"] });
    const refusals = report.diagnostics.filter((entry) => entry.code === "WRITE_SCOPE_VIOLATION");
    expect(refusals.length).toBeGreaterThan(0);
    // The patterns are outside the reserved prefix and still migrate.
    expect(report.idsGenerated.length).toBeGreaterThan(0);
    const inventory = inventoryScaffold({ scaffoldRoot: root });
    const context = inventory.files.filter((file) => file.path.startsWith("context/"));
    expect(context.flatMap((file) => file.parsed.entities)).toEqual([]);
  });
});

describe("the report", () => {
  it("carries every section 13.6 field", { timeout: 30_000 }, () => {
    const root = scaffold();
    const report = migrateScaffold({ scaffoldRoot: root });
    expect(report.filesScanned).toBe(25);
    expect(report.filesSkipped.length).toBe(6);
    expect(report.filesSkipped.every((entry) => entry.reason !== "")).toBe(true);
    expect(Object.keys(report.entitiesByType).sort()).toEqual([
      "architecture",
      "component",
      "convention",
      "decision",
      "guide",
      "pattern",
      "risk",
    ]);
    expect(report.idsGenerated.length + report.idsPreserved.length).toBeGreaterThan(0);
    expect(report.diffs.length).toBeGreaterThan(0);
    expect(report.abstentions.length).toBeGreaterThan(0);
    expect(renderMigrationReport(report)).toContain("files scanned:      25");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("a file that already carries ids", () => {
  it("is skipped, and its ids are never regenerated", TWO_MIGRATIONS, () => {
    const root = scaffold();
    migrateScaffold({ scaffoldRoot: root });
    const idsFirst = inventoryScaffold({ scaffoldRoot: root })
      .files.flatMap((file) => file.parsed.entities.map((entry) => entry.entity.id))
      .sort();

    // Wipe the log entirely: idempotency now has to come from the *files*, not
    // from a replay record. Section 13.3's "a file that already contains valid
    // IDs is skipped" is what has to hold here.
    writeFileSync(operationLogPath(root), "", "utf-8");
    const again = migrateScaffold({ scaffoldRoot: root });
    expect(again.idsGenerated).toEqual([]);

    const idsSecond = inventoryScaffold({ scaffoldRoot: root })
      .files.flatMap((file) => file.parsed.entities.map((entry) => entry.entity.id))
      .sort();
    expect(idsSecond).toEqual(idsFirst);
  });

  it("treats a related_to pair authored under a non-migration opId as already converted", () => {
    const root = mkdtempSync(join(tmpdir(), "mig-existing-edge-"));
    const source = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
    const target = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
    mkdirSync(join(root, "patterns"), { recursive: true });
    writeFileSync(
      join(root, "patterns", "a.md"),
      [
        "---",
        "name: a",
        "edges:",
        "  - target: patterns/b.md",
        "    condition: legacy navigation note",
        "mex:",
        `  id: ${source}`,
        "  type: pattern",
        "  status: promoted",
        "  revision: 1",
        "  title: a",
        "---",
        "",
        "# A",
        "",
        "Source prose.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "patterns", "b.md"),
      [
        "---",
        "name: b",
        "mex:",
        `  id: ${target}`,
        "  type: pattern",
        "  status: promoted",
        "  revision: 1",
        "  title: b",
        "---",
        "",
        "# B",
        "",
        "Target prose.",
        "",
      ].join("\n"),
    );

    const initialSource = readFileSync(join(root, "patterns", "a.md"), "utf-8");
    const sourceEntity = parseWikiMarkdown({ path: "patterns/a.md", text: initialSource }).entities[0]!.entity;
    const authored = applyOperation(
      {
        opId: "agent-authored-related-to",
        type: "add-relation",
        entityId: source,
        baseRevision: sourceEntity.revision,
        baseContentHash: sourceEntity.location.entityContentHash,
        actor: { kind: "agent", id: "migration-test" },
        timestamp: "2026-09-06T00:00:00.000Z",
        payload: {
          relation: {
            type: "related_to",
            target,
            note: "manually authored note",
          },
        },
      },
      { scaffoldRoot: root },
    );
    expect(authored.ok).toBe(true);

    const sourceBefore = readFileSync(join(root, "patterns", "a.md"), "utf-8");
    expect(planMigration({ scaffoldRoot: root }).edgesConverted).toBe(0);

    const report = migrateScaffold({ scaffoldRoot: root });
    expect(report.edgesConverted).toBe(0);
    expect(report.diagnostics.filter((entry) => entry.code === "DUPLICATE_RELATION")).toEqual([]);
    expect(readFileSync(join(root, "patterns", "a.md"), "utf-8")).toBe(sourceBefore);
    expect(acceptedOperations(readAuditLog(root)).map((entry) => entry.opId)).toEqual([
      "agent-authored-related-to",
    ]);
    rmSync(root, { recursive: true, force: true });
  });
});
