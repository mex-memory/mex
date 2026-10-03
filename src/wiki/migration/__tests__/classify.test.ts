import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { inventoryScaffold, fileAt, type InventoryFile } from "../inventory.js";
import {
  classifyFile,
  isSubstantial,
  orderForAdoption,
  proseWeight,
  roleFor,
  sectionTextOf,
  SUBSTANTIAL_SECTION_LINES,
  SUBSTANTIAL_SECTION_WORDS,
  type Candidate,
} from "../classify.js";
import { parseWikiMarkdown } from "../../markdown/codec.js";
import { parseDocument } from "../../markdown/parse.js";
import { applyOperation } from "../../operations/apply.js";
import { readFileSync } from "node:fs";

const CORPUS = resolve(__dirname, "..", "..", "..", "..", "test", "fixtures", "wiki-migration", "tier1");

const inventory = inventoryScaffold({ scaffoldRoot: CORPUS });

function classified(path: string) {
  const file = fileAt(inventory, path);
  if (file === undefined) throw new Error(`${path} not in the inventory`);
  return classifyFile(file);
}

function inline(text: string, path = "context/architecture.md"): InventoryFile {
  return { path, absolutePath: path, text, parsed: parseWikiMarkdown({ path, text }), headings: parseDocument(text).headings };
}

describe("inventory", () => {
  it("reads every corpus file exactly once, in a deterministic order", () => {
    expect(inventory.files.length).toBe(25);
    expect(inventory.diagnostics).toEqual([]);
    const again = inventoryScaffold({ scaffoldRoot: CORPUS });
    expect(again.files.map((file) => file.path)).toEqual(inventory.files.map((file) => file.path));
  });

  it("carries headings from the codec's own AST seam, not a regex", () => {
    const decisions = fileAt(inventory, "context/decisions.md");
    expect(decisions?.headings.map((heading) => heading.depth)).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 2, 3, 3]);
  });

  it("reports an unreadable file rather than throwing", () => {
    const result = inventoryScaffold({
      scaffoldRoot: CORPUS,
      readFile: (path) => {
        if (path.endsWith("SYNC.md")) throw new Error("EACCES");
        return "";
      },
    });
    expect(result.files.length).toBe(24);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["WIKI_PARSE_ERROR"]);
  });
});

describe("the substantiality threshold", () => {
  it("is exported, and both sides of it are real", () => {
    const thin = "\nOne short line.\n";
    const thick = `\n${"Words enough to make a claim that stands on its own and reads as a claim. ".repeat(2)}\nA second line here.\nAnd a third line here.\n`;
    expect(isSubstantial(thin)).toBe(false);
    expect(isSubstantial(thick)).toBe(true);
    expect(proseWeight(thin).lines).toBeLessThan(SUBSTANTIAL_SECTION_LINES);
    expect(proseWeight(thick).words).toBeGreaterThanOrEqual(SUBSTANTIAL_SECTION_WORDS);
  });

  it("does not count headings or fenced code as prose", () => {
    const section = "\n```\nlots of code words here and here and here and here and here and here\nmore code lines\nand more\n```\n";
    expect(proseWeight(section)).toEqual({ lines: 0, words: 0 });
  });

  it("abstains on a thin section rather than making an entity of it", () => {
    const file = inline(`---\nname: architecture\n---\n\n# A\n\n## Thin\n\nOne line.\n`);
    const result = classifyFile(file);
    expect(result.candidates.map((candidate) => candidate.target)).toEqual([{ at: "file" }]);
    expect(result.abstentions.map((entry) => entry.target)).toEqual([
      { at: "heading", ordinal: 1, text: "Thin", depth: 2, start: file.text.indexOf("## Thin") },
    ]);
    expect(result.abstentions[0]?.reason).toContain("not to create an entity for every paragraph");
  });
});

describe("classification over the corpus", () => {
  it("adopts the architecture file and its four components", () => {
    const result = classified("context/architecture.md");
    expect(result.candidates.map((candidate) => `${candidate.type}:${candidate.title}`)).toEqual([
      "component:Ingest",
      "component:Threading",
      "component:Routing",
      "component:Delivery",
      "architecture:architecture",
    ]);
    // Its six depth-3 subsections are reported, not adopted — see below.
    expect(result.abstentions.every((entry) => entry.target?.at === "heading" && entry.target.depth === 3)).toBe(true);
  });

  it("makes a decision of a log entry, and abstains on the log itself", () => {
    const result = classified("context/decisions.md");
    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "Store raw mail before parsing it",
      "One queue owns a ticket",
      "Queue rules are data, not code",
      "Keep the work queue in Postgres",
      "Two-phase schema changes",
      "Search without a search cluster",
      "A single outbound sender",
      "Reassign rather than share ownership",
    ]);
    expect(result.candidates.every((candidate) => candidate.type === "decision")).toBe(true);
    // The two containers, and the two entries that state no decision.
    expect(result.abstentions.map((entry) => (entry.target?.at === "heading" ? entry.target.text : null))).toEqual([
      "Decision Log",
      "Open questions",
      "Raw store retention",
      "Multi-region ingest",
    ]);
  });

  it("abstains on a decision-log entry with no decision marker", () => {
    const file = inline(
      `---\nname: decisions\n---\n\n# D\n\n## Decision Log\n\n### A real one\n\n**Decision:** we did the thing.\n**Reasoning:** because.\n\n### Just a note\n\nSome prose that expresses no decision at all, at some length.\n`,
      "context/decisions.md",
    );
    const result = classifyFile(file);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(["A real one"]);
    expect(result.abstentions.map((entry) => (entry.target?.at === "heading" ? entry.target.text : null))).toEqual([
      "Decision Log",
      "Just a note",
    ]);
  });

  it("makes a pattern file one entity and leaves its sections alone", () => {
    const result = classified("patterns/add-queue-rule.md");
    expect(result.candidates.map((candidate) => candidate.target.at)).toEqual(["file"]);
    expect(result.candidates[0]?.type).toBe("pattern");
    expect(result.abstentions).toEqual([]);
  });

  it("gives a risk register no file-level entity, only its risks", () => {
    const result = classified("context/risks.md");
    expect(result.candidates.length).toBe(6);
    expect(result.candidates.every((candidate) => candidate.target.at === "heading")).toBe(true);
    expect(result.candidates.every((candidate) => candidate.type === "risk")).toBe(true);
  });

  it("reports a nested subsection rather than passing over it in silence", () => {
    // architecture.md has six depth-3 headings inside two of its components.
    // They do not become entities, and section 13.2 says ambiguous prose is
    // retained *and reported* — their prose is now inside a parent's body, and
    // a reader has to be told that.
    const result = classified("context/architecture.md");
    const nested = result.abstentions.filter((entry) => entry.target?.at === "heading" && entry.target.depth === 3);
    expect(nested.length).toBe(6);
    expect(nested[0]?.reason).toContain("stays with the section that contains it");
  });

  it.each(["context/glossary.md", "context/security.md"])("abstains on %s rather than deriving a type from its directory", (path) => {
    const result = classified(path);
    expect(result.candidates).toEqual([]);
    expect(result.abstentions).toEqual([{
      file: path,
      target: null,
      kind: "untyped",
      reason: expect.stringContaining("Declare the type in the file's frontmatter"),
    }]);
    expect(result.abstentions[0]?.reason).toContain("mex wiki migrate");
    expect(roleFor(path)).toBeNull();
  });

  it("gives the stack file setup writes one file-level architecture entity, by name (#227)", () => {
    const result = classified("context/stack.md");
    expect(result.abstentions).toEqual([]);
    expect(result.candidates).toEqual([expect.objectContaining({
      target: { at: "file" },
      type: "architecture",
      title: "stack",
    })]);
    expect(roleFor("context/stack.md")).toMatchObject({ fileType: "architecture", sectionType: null });
  });

  it("preserves the explicit named context rules", () => {
    expect(roleFor("context/risks.md")?.fileType).toBeNull();
    expect(roleFor("context/risks.md")?.sectionType).toBe("risk");
    expect(roleFor("context/conventions.md")?.fileType).toBe("convention");
    expect(classified("context/risks.md").candidates.every((candidate) => candidate.target.at === "heading")).toBe(true);
  });

  it("does not infer a type for unknown direct or nested context paths", () => {
    for (const path of ["context/nested/thing.md", "context/thing.md", "contextual/thing.md"]) {
      expect(roleFor(path)).toBeNull();
    }
  });

  it("preserves authored metadata on an otherwise unknown context path", () => {
    const file = inline(`---\nmex:\n  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n  type: guide\n  status: promoted\n  revision: 2\n  title: Security runbook\n---\n\nOperational guidance.\n`, "context/security.md");
    expect(classifyFile(file)).toMatchObject({ candidates: [], abstentions: [], skipped: true, skipReason: "already carries entity metadata" });
  });

  it("keeps navigation and generated files ahead of both directory rules", () => {
    expect(roleFor("patterns/INDEX.md")).toBeNull();
    expect(roleFor("patterns/README.md")).toBeNull();
    expect(roleFor("ROUTER.md")).toBeNull();
  });

  it("skips navigation and generated files", () => {
    for (const path of ["ROUTER.md", "AGENTS.md", "SETUP.md", "SYNC.md", "patterns/README.md", "patterns/INDEX.md"]) {
      const result = classified(path);
      expect(result.skipped, path).toBe(true);
      expect(result.candidates, path).toEqual([]);
    }
  });

  it("skips a file that already carries entity metadata", () => {
    const file = inline(`---\nname: architecture\nmex:\n  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n  type: architecture\n  status: promoted\n  revision: 1\n  title: A\n---\n\n# A\n\nProse.\n`);
    const result = classifyFile(file);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("already carries entity metadata");
  });

  it("classifies the whole corpus into a stable, non-empty set", () => {
    const all = inventory.files.map((file) => classifyFile(file));
    const candidates = all.flatMap((entry) => entry.candidates);
    const abstentions = all.flatMap((entry) => entry.abstentions);
    // A "prose unchanged" property over a corpus nothing was written to would
    // pass for the wrong reason, so the count is pinned here — written as the
    // sum it is, so a change says which rule moved.
    const architecture = 4 + 1; // four components, plus the file
    const conventions = 9 + 1;
    const decisions = 8; // ten entries, two of which state no decision
    const setup = 6 + 1;
    const risks = 6; // a register is a list, not one claim
    const patterns = 6; // one file-level entity each
    const stack = 1; // the file, by name; its lists stay prose
    expect(candidates.length).toBe(
      architecture + conventions + decisions + setup + risks + patterns + stack,
    );
    // The seven context files no rule names and none declares a type for.
    const untyped = abstentions.filter((entry) => entry.target === null);
    expect(untyped).toHaveLength(7);
    expect(untyped.every((entry) => entry.kind === "untyped")).toBe(true);
    expect(abstentions.some((entry) => entry.target !== null)).toBe(true);
    expect(abstentions.length).toBeGreaterThan(7);
    expect(all.filter((entry) => entry.skipped).length).toBe(6);
  });
});

describe("adoption order", () => {
  it("puts the deepest, latest heading first and the file-level entity last", () => {
    const candidates = classified("context/architecture.md").candidates;
    const ordered = orderForAdoption(candidates);
    expect(ordered.map((candidate) => candidate.title)).toEqual([
      "Delivery",
      "Routing",
      "Threading",
      "Ingest",
      "architecture",
    ]);
  });

  it("adopts a nested `###` before the `##` that contains it", () => {
    const file = inline(
      `---\nname: decisions\n---\n\n# D\n\n## Decision Log\n\n### One\n\n**Decision:** a.\n**Reasoning:** b.\n`,
      "context/decisions.md",
    );
    const container: Candidate = {
      file: "context/decisions.md",
      target: { at: "heading", ordinal: 1, text: "Decision Log", depth: 2, start: file.text.indexOf("## Decision Log") },
      type: "architecture",
      title: "Decision Log",
      rule: "hypothetical",
    };
    const ordered = orderForAdoption([container, ...classifyFile(file).candidates]);
    expect(ordered.map((candidate) => candidate.title)).toEqual(["One", "Decision Log"]);
  });
});

describe("scaffold walking", () => {
  it("honours wiki.exclude rather than walking around it", () => {
    const root = mkdtempSync(join(tmpdir(), "mig-exclude-"));
    for (const path of ["context/architecture.md", "vendor/thing.md"]) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, "# x\n", "utf-8");
    }
    const result = inventoryScaffold({ scaffoldRoot: root, exclude: ["vendor/**"] });
    expect(result.files.map((file) => file.path)).toEqual(["context/architecture.md"]);
  });
});

describe("section extents", () => {
  it("stops a section at the next heading of equal or shallower depth", () => {
    const file = inline(`# A\n\nintro\n\n## One\n\nalpha\n\n### Deep\n\nbeta\n\n## Two\n\ngamma\n`);
    expect(sectionTextOf(file, 1)).toContain("alpha");
    expect(sectionTextOf(file, 1)).toContain("beta");
    expect(sectionTextOf(file, 1)).not.toContain("gamma");
    expect(sectionTextOf(file, 2)).toContain("beta");
    expect(sectionTextOf(file, 2)).not.toContain("gamma");
  });
});

describe("why the adoption order is what it is", () => {
  /**
   * The order is a correctness property, and this is the test that provokes it.
   *
   * Pinning `orderForAdoption`'s output is a regression detector; it does not
   * assert the *reason*. What follows adopts a parent and then its child
   * through the real pipeline and asserts P5 refuses the second — and then
   * adopts them in the other order and asserts both land. Without this the
   * constraint is a preference with a passing test in front of it, which is
   * finding 44's shape exactly.
   */
  function scaffoldWith(text: string): string {
    const root = mkdtempSync(join(tmpdir(), "mig-order-"));
    mkdirSync(join(root, "context"), { recursive: true });
    writeFileSync(join(root, "context", "decisions.md"), text, "utf-8");
    return root;
  }

  const SOURCE = [
    "---",
    "name: decisions",
    "---",
    "",
    "# Decisions",
    "",
    "## Decision Log",
    "",
    "Prose belonging to the log itself, long enough to be a section of substance.",
    "It runs to several lines so the container is not thin for the wrong reason.",
    "A third line, so the threshold is cleared on both counts here.",
    "",
    "### One queue owns a ticket",
    "",
    "**Decision:** a ticket has exactly one owning queue.",
    "**Reasoning:** shared ownership produced tickets nobody answered.",
    "",
  ].join("\n");

  function adopt(root: string, ordinal: number, text: string, type: string, opId: string) {
    return applyOperation(
      {
        opId,
        type: "create-entry",
        actor: { kind: "human", id: "test" },
        timestamp: "2026-08-24T00:00:00.000Z",
        payload: {
          file: "context/decisions.md",
          adopt: { at: "heading", ordinal, text },
          type,
          title: text,
        },
      },
      { scaffoldRoot: root, unconditional: true },
    );
  }

  it("refuses the child once its parent is already an entity", () => {
    const root = scaffoldWith(SOURCE);
    // Parent first — the wrong order.
    const parent = adopt(root, 1, "Decision Log", "architecture", "op-parent");
    expect(parent.ok, parent.diagnostics.map((entry) => entry.message).join(" | ")).toBe(true);

    const child = adopt(root, 2, "One queue owns a ticket", "decision", "op-child");
    expect(child.ok).toBe(false);
    expect(child.diagnostics.map((entry) => entry.code)).toContain("WRITE_SCOPE_VIOLATION");
    // And it says which entity it would have disturbed, rather than failing vaguely.
    expect(child.diagnostics.map((entry) => entry.message).join(" ")).toContain("which it does not name");
    // Refused means refused: the file is what the parent adoption left.
    expect(readFileSync(join(root, "context", "decisions.md"), "utf-8")).not.toContain("type: decision");
  });

  it("accepts both when the child is adopted first", () => {
    const root = scaffoldWith(SOURCE);
    const child = adopt(root, 2, "One queue owns a ticket", "decision", "op-child");
    expect(child.ok, child.diagnostics.map((entry) => entry.message).join(" | ")).toBe(true);

    const parent = adopt(root, 1, "Decision Log", "architecture", "op-parent");
    expect(parent.ok, parent.diagnostics.map((entry) => entry.message).join(" | ")).toBe(true);

    const final = readFileSync(join(root, "context", "decisions.md"), "utf-8");
    const parsed = parseWikiMarkdown({ path: "context/decisions.md", text: final });
    expect(parsed.entities.length).toBe(2);
    expect(parsed.diagnostics).toEqual([]);
    // The prose survived both insertions, character for character.
    expect(final).toContain("**Decision:** a ticket has exactly one owning queue.");
    expect(final).toContain("Prose belonging to the log itself, long enough to be a section of substance.");
  });

  it("and orderForAdoption is what produces the accepted order", () => {
    const file = inline(SOURCE, "context/decisions.md");
    const container: Candidate = {
      file: "context/decisions.md",
      target: { at: "heading", ordinal: 1, text: "Decision Log", depth: 2, start: file.text.indexOf("## Decision Log") },
      type: "architecture",
      title: "Decision Log",
      rule: "the container, hypothetically adopted",
    };
    const ordered = orderForAdoption([container, ...classifyFile(file).candidates]);
    expect(ordered.map((candidate) => candidate.title)).toEqual(["One queue owns a ticket", "Decision Log"]);
  });
});

describe("a declared type (#227)", () => {
  const front = (keys: string) =>
    `---\nname: routing\ndescription: How requests reach handlers.\n${keys}last_updated: 2026-09-21\n---\n\n`
    + "# Routing\n\n## Registration\n\nRoutes are registered on the app and compiled once.\n";

  it("adopts a context file no rule names as one file-level entity of the declared type", () => {
    const result = classifyFile(inline(front("type: component\n"), "context/routing.md"));
    expect(result.abstentions).toEqual([]);
    expect(result.candidates).toEqual([expect.objectContaining({
      target: { at: "file" },
      type: "component",
      title: "routing",
      rule: expect.stringContaining("declares `type: component`"),
    })]);
  });

  it("is honoured outside `context/` too, because the declaration is the evidence and not the path", () => {
    const result = classifyFile(inline(front("type: guide\n"), "runbooks/deploy.md"));
    expect(result.candidates.map((candidate) => candidate.type)).toEqual(["guide"]);
  });

  it("leaves the sections of a declared file as prose", () => {
    const result = classifyFile(inline(front("type: convention\n"), "context/routing.md"));
    expect(result.candidates.map((candidate) => candidate.target.at)).toEqual(["file"]);
  });

  it("accepts a declaration that agrees with the name rule", () => {
    const result = classifyFile(inline(front("type: architecture\n"), "context/stack.md"));
    expect(result.candidates.map((candidate) => candidate.type)).toEqual(["architecture"]);
    expect(result.abstentions).toEqual([]);
  });

  it.each([
    ["an unknown type", "type: subsystem\n", "`subsystem`"],
    ["a Team-owned type", "type: relay\n", "`relay`"],
    ["a Spec-family type, which only governed Inbox authoring creates", "type: requirement\n", "mex inbox"],
    ["a value that is not a string", "type: [component]\n", "not a type name"],
    ["an empty value", "type: \"\"\n", "not a type name"],
    ["an explicit null", "type: null\n", "not a type name"],
  ])("refuses %s and changes nothing", (_label, keys, expected) => {
    const result = classifyFile(inline(front(keys), "context/routing.md"));
    expect(result.candidates).toEqual([]);
    expect(result.abstentions).toEqual([{
      file: "context/routing.md",
      target: null,
      kind: "invalid-declaration",
      reason: expect.stringContaining(expected),
    }]);
  });

  it("refuses a declaration that disagrees with the name rule rather than choosing", () => {
    const result = classifyFile(inline(front("type: guide\n"), "context/stack.md"));
    expect(result.candidates).toEqual([]);
    expect(result.abstentions).toEqual([expect.objectContaining({
      kind: "invalid-declaration",
      reason: expect.stringContaining("change it to `architecture`"),
    })]);
  });

  it("refuses a declaration on a file whose entities are its sections", () => {
    const result = classifyFile(inline(front("type: risk\n"), "context/risks.md"));
    expect(result.candidates).toEqual([]);
    expect(result.abstentions[0]).toMatchObject({ kind: "invalid-declaration", target: null });
    expect(result.abstentions[0]?.reason).toContain("Remove the `type` key");
  });

  it("refuses a pattern that declares another type", () => {
    const result = classifyFile(inline(front("type: guide\n"), "patterns/add-route.md"));
    expect(result.candidates).toEqual([]);
    expect(result.abstentions[0]?.kind).toBe("invalid-declaration");
  });

  it("never reaches a navigation file, a Team-owned file, or one already adopted", () => {
    expect(classifyFile(inline(front("type: component\n"), "ROUTER.md")).skipped).toBe(true);
    expect(classifyFile(inline(front("type: component\n"), "relays/relay.md")).skipped).toBe(true);
    const adopted = "---\ntype: guide\nmex:\n  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n  type: guide\n  status: promoted\n"
      + "  revision: 1\n  title: Runbook\n---\n\nSteps.\n";
    expect(classifyFile(inline(adopted, "context/runbook.md"))).toMatchObject({ skipped: true, candidates: [] });
  });
});
