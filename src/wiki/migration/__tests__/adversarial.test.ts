/**
 * Tier 3 — the adversarial cases, where **abstention is the assertion**.
 *
 * Every fixture here is a shape migration must not guess at. A classifier
 * tested only on the corpus it was written against passes by construction; this
 * is the antidote, and the thing being asserted is that nothing was written and
 * something was reported.
 *
 * Built in-test rather than vendored, because each one is a handful of lines
 * whose point is a single structural property, and a file on disk would put
 * that property one indirection away from the assertion that names it.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateScaffold, planMigration } from "../migrate.js";
import { inventoryScaffold } from "../inventory.js";
import { classifyFile } from "../classify.js";
import {
  findGeneratedRegion,
  generatedViewEdit,
  renderGeneratedView,
  rowsFor,
  planGeneratedView,
  GENERATED_BEGIN,
  GENERATED_END,
} from "../generated.js";
import { checkOnlyRangesChanged } from "../../markdown/ranges.js";
import { parseWikiMarkdown } from "../../markdown/codec.js";

function scaffoldOf(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mig-adv-"));
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }
  return root;
}

/** Every file's bytes, so "nothing was written" can be asserted directly. */
function snapshot(root: string): Map<string, string> {
  return new Map(inventoryScaffold({ scaffoldRoot: root }).files.map((file) => [file.path, file.text]));
}

const FRONT = (extra = "") => `---\nname: architecture\ndescription: "x"\n${extra}---\n\n`;

describe("unknown context file classification", () => {
  it("keeps ambiguous file bytes and legacy metadata unchanged on preview, apply, and repeat", () => {
    const path = "context/security.md";
    const text = FRONT("last_updated: 2020-01-01\nedges: []\n")
      + "# Security procedures\n\n## Account recovery\n\nFollow the recorded recovery process.\n";
    const root = scaffoldOf({ [path]: text });
    const preview = planMigration({ scaffoldRoot: root });
    expect(preview.planned).toEqual([]);
    expect(preview.abstentions).toEqual([{ file: path, target: null, reason: expect.stringContaining("does not establish architecture") }]);
    expect(readFileSync(join(root, path), "utf8")).toBe(text);
    for (let run = 0; run < 2; run += 1) {
      const report = migrateScaffold({ scaffoldRoot: root });
      expect(report.idsGenerated).toEqual([]);
      expect(report.filesUnchanged).toContain(path);
      expect(report.abstentions).toEqual(preview.abstentions);
      expect(readFileSync(join(root, path), "utf8")).toBe(text);
    }
  });
});

describe("tier 3 — merge conflict markers", () => {
  it("migrates without truncating the body, and writes no entity inside the region", () => {
    const text =
      FRONT() +
      "# Architecture\n\nIntro prose that belongs to nobody yet and must survive.\n\n" +
      "## Ingest\n\n<<<<<<< HEAD\nOne side of a bad merge, several words long so it clears the threshold.\n=======\nThe other side, also several words long and also prose somebody wrote.\n>>>>>>> branch\n\nTrailing prose after the region.\n";
    const root = scaffoldOf({ "context/architecture.md": text });

    const report = migrateScaffold({ scaffoldRoot: root });
    expect(report.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    const after = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    // `=======` is a valid setext underline, so a conflict region parses as a
    // heading unless suppressed (finding 21). If the suppression were lost,
    // migration would adopt the conflict as a section.
    expect(after).toContain("<<<<<<< HEAD");
    expect(after).toContain("Trailing prose after the region.");
    expect(after.match(/<!-- mex:entity/g)?.length ?? 0).toBe(1);
    const inventory = inventoryScaffold({ scaffoldRoot: root });
    expect(inventory.files[0]?.parsed.entities.length).toBe(2);
  });
});

describe("tier 3 — CRLF and BOM", () => {
  it("keeps CRLF terminators, and writes none of its own", () => {
    const text = (FRONT() + "# Architecture\n\nIntro.\n\n## Ingest\n\nProse enough to clear the threshold here, on more than one line of it.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n").replace(/\n/g, "\r\n");
    const root = scaffoldOf({ "context/architecture.md": text });
    migrateScaffold({ scaffoldRoot: root });

    const after = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    // Finding 42: a lone LF inside a declared range is invisible to the scope
    // check, because it is inside the range the write declared.
    expect(after.includes("\r\n")).toBe(true);
    expect(/[^\r]\n/.test(after), "a lone LF was written into a CRLF file").toBe(false);
    expect(inventoryScaffold({ scaffoldRoot: root }).files[0]?.parsed.entities.length).toBe(2);
  });

  it("keeps a BOM where it was", () => {
    const text = "﻿" + FRONT() + "# Architecture\n\nIntro.\n\n## Ingest\n\nProse enough to clear the threshold here, on more than one line of it.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n";
    const root = scaffoldOf({ "context/architecture.md": text });
    migrateScaffold({ scaffoldRoot: root });

    const after = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    expect(after.charCodeAt(0)).toBe(0xfeff);
    // Finding 20: remark strips the BOM before parsing, so every offset is
    // short by one on these files. An adoption placed at an uncorrected offset
    // would land one character inside the heading.
    expect(after).toMatch(/<!-- mex:entity[\s\S]*?-->\r?\n## Ingest/);
  });
});

describe("tier 3 — a fenced or indented metadata marker", () => {
  it("does not read a marker inside a fence as an entity, and does not write one there", () => {
    const text =
      FRONT() +
      "# Architecture\n\nIntro.\n\n## Ingest\n\nA section documenting the format, with enough prose to clear the bar here.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n\n```markdown\n<!-- mex:entity\nid: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n-->\n```\n\nMore prose after the fence.\n";
    const root = scaffoldOf({ "context/architecture.md": text });
    migrateScaffold({ scaffoldRoot: root });

    const inventory = inventoryScaffold({ scaffoldRoot: root });
    // The fenced marker is content, not metadata — the engine has to be able to
    // document itself. Two real entities: the file and its one section.
    expect(inventory.files[0]?.parsed.entities.length).toBe(2);
    expect(readFileSync(join(root, "context", "architecture.md"), "utf-8")).toContain("```markdown");
  });
});

describe("tier 3 — malformed and explicitly null frontmatter", () => {
  it("abstains on a file whose frontmatter will not parse, and writes nothing", () => {
    const text = "---\nname: architecture\ndescription: [unclosed\n---\n\n# Architecture\n\nProse that must survive untouched, at some length, over lines.\nA second line.\nA third.\n";
    const root = scaffoldOf({ "context/architecture.md": text });
    const before = snapshot(root);

    const report = migrateScaffold({ scaffoldRoot: root });
    expect(snapshot(root)).toEqual(before);
    expect(report.idsGenerated).toEqual([]);
    // Reported, not silently passed over. An abstention rather than a
    // diagnostic: nothing is wrong with the scaffold, migration simply will not
    // write into a file it could not read.
    expect(report.abstentions.map((entry) => entry.file)).toEqual(["context/architecture.md"]);
    expect(report.abstentions[0]?.reason).toContain("could not be read cleanly");
  });

  it("abstains on an explicitly null field rather than reading it as absent", () => {
    // Finding 11: YAML distinguishes a missing key from one set to `null`, and
    // the second is nearly always a mistake worth reporting.
    const text = "---\nname: null\ndescription: \"x\"\n---\n\n# Architecture\n\nProse.\n";
    const root = scaffoldOf({ "context/architecture.md": text });
    const file = inventoryScaffold({ scaffoldRoot: root }).files[0]!;
    const classification = classifyFile(file);
    // `name: null` is not a title, so the file-level entity has none to take
    // and the classifier says so rather than inventing one.
    const titles = classification.candidates.map((candidate) => candidate.title);
    expect(titles).not.toContain("null");
  });
});

describe("tier 3 — a root grounding on a multi-entity file", () => {
  const SECTIONS =
    "Intro.\n\n## Ingest\n\nProse enough to clear the threshold, over several lines of it here.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n\n## Routing\n\nMore prose, also enough to clear the threshold, over several lines here.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n";
  const ROOT = 'grounds_to:\n  - node: "function:1c9d4b7e2f5a8036c4e1b9d7a2f60358"\n    fingerprint: "mh:64:4b1c7e29"\n';

  it("moves to the file-level entity, never to a section (#226)", () => {
    // This used to stay at the root, which is what setup produced on every
    // multi-entity file it populated. The file-level entity is the document the
    // frontmatter describes, so attaching it there guesses no section.
    const root = scaffoldOf({ "context/architecture.md": FRONT(ROOT) + "# Architecture\n\n" + SECTIONS });

    const report = migrateScaffold({ scaffoldRoot: root });
    expect(report.groundingsMoved).toBe(1);
    expect(report.groundingsAmbiguous).toBe(0);

    const after = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    expect(after).not.toMatch(/^grounds_to:/m);
    expect(after).toMatch(/^      fingerprint: "?mh:64:4b1c7e29"?$/m);
    // Exactly one copy, and it is the file-level entity's.
    expect((after.match(/grounds_to:/g) ?? []).length).toBe(1);
    const entities = parseWikiMarkdown({ path: "context/architecture.md", text: after }).entities;
    const fileLevel = entities.filter((entry) => entry.metadataKind === "frontmatter");
    expect(fileLevel).toHaveLength(1);
    expect(fileLevel[0]!.entity.groundsTo.map((entry) => entry.node)).toEqual(["function:1c9d4b7e2f5a8036c4e1b9d7a2f60358"]);
    const sections = entities.filter((entry) => entry.metadataKind !== "frontmatter");
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) expect(section.entity.groundsTo).toEqual([]);
  });

  it("is reported and left exactly where it was when no file-level entity can own it", () => {
    // A risk register yields section entities only. Nothing can say which
    // risk a document-level grounding describes (section 9.4), so it stays at
    // the root, unattributed and intact.
    const text = FRONT(ROOT) + "# Risks\n\n" + SECTIONS;
    const root = scaffoldOf({ "context/risks.md": text });

    const report = migrateScaffold({ scaffoldRoot: root });
    expect(report.groundingsMoved).toBe(0);
    expect(report.groundingsAmbiguous).toBe(1);
    expect(report.diagnostics.filter((entry) => entry.code === "AMBIGUOUS_MIGRATION").length).toBe(1);

    const after = readFileSync(join(root, "context", "risks.md"), "utf-8");
    expect(after).toMatch(/^grounds_to:/m);
    expect(after).toContain('    fingerprint: "mh:64:4b1c7e29"');
    // And there is exactly one copy of it: reported does not mean duplicated.
    expect((after.match(/grounds_to:/g) ?? []).length).toBe(1);
    const entities = parseWikiMarkdown({ path: "context/risks.md", text: after }).entities;
    expect(entities.length).toBeGreaterThan(0);
    for (const entry of entities) expect(entry.entity.groundsTo).toEqual([]);
  });
});

describe("tier 3 — an edge into a multi-entity file", () => {
  it("is preserved and reported, never guessed", () => {
    const root = scaffoldOf({
      "patterns/thing.md":
        '---\nname: thing\ndescription: "x"\nedges:\n  - target: context/risks.md\n    condition: when weighing a failure mode\n---\n\n# Thing\n\nProse enough to clear the bar here, over several lines of it now.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n',
      "context/risks.md":
        FRONT() +
        "# Risks\n\nIntro.\n\n## One\n\nProse enough to clear the threshold, over several lines of it here.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n\n## Two\n\nAlso enough prose to clear the threshold here, over several lines of it.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n",
    });

    const report = migrateScaffold({ scaffoldRoot: root });
    // risks.md yields two risks and no file-level entity, so "that file" names
    // no single entity and the edge cannot be translated.
    expect(report.edgesConverted).toBe(0);
    expect(report.edgesAmbiguous).toBe(1);

    const pattern = readFileSync(join(root, "patterns", "thing.md"), "utf-8");
    expect(pattern).toContain("  - target: context/risks.md");
    expect(pattern).toContain("    condition: when weighing a failure mode");
    expect(pattern).not.toContain("related_to");
  });
});

describe("generated views", () => {
  const SCAFFOLD = {
    "patterns/INDEX.md":
      '---\nname: pattern-index\ndescription: "x"\n---\n\n# Pattern Index\n\nHand-written prose above the markers that must survive.\n\n' +
      `${GENERATED_BEGIN}\n\n| Entity | Where |\n|---|---|\n| stale row | \`nowhere\` |\n\n${GENERATED_END}\n\nHand-written prose below the markers that must also survive.\n`,
    "patterns/thing.md":
      '---\nname: thing\ndescription: "x"\n---\n\n# Thing\n\nProse enough to clear the bar here, over several lines of it now.\nA second line of prose that carries several more words along with it.\nAnd a third line of prose to be certain the bar is cleared.\n',
  };

  it("reports drift when the block no longer matches, without touching the file", () => {
    const root = scaffoldOf(SCAFFOLD);
    migrateScaffold({ scaffoldRoot: root });
    const inventory = inventoryScaffold({ scaffoldRoot: root });
    const index = inventory.files.find((file) => file.path === "patterns/INDEX.md")!;

    const plan = planGeneratedView(index, inventory, "pattern");
    expect(plan?.stale).toBe(true);
    expect(plan?.diagnostics.map((entry) => entry.code)).toEqual(["GENERATED_VIEW_DRIFT"]);
    // Info, not error: the hand edit is still there and regenerating is the
    // user's call.
    expect(plan?.diagnostics[0]?.severity).toBe("info");
  });

  it("changes nothing outside the markers, proven over the whole file", () => {
    const root = scaffoldOf(SCAFFOLD);
    migrateScaffold({ scaffoldRoot: root });
    const inventory = inventoryScaffold({ scaffoldRoot: root });
    const index = inventory.files.find((file) => file.path === "patterns/INDEX.md")!;

    const edit = generatedViewEdit(index, inventory, "pattern")!;
    const produced = index.text.slice(0, edit.start) + edit.text + index.text.slice(edit.end);
    // The scoped-mutation harness, over the file, against the declared range —
    // the same check every P5 write goes through.
    const check = checkOnlyRangesChanged(index.text, produced, [
      { start: edit.start, end: edit.end, label: edit.label },
    ]);
    expect(check.ok, check.ok ? "" : check.message).toBe(true);

    expect(produced).toContain("Hand-written prose above the markers that must survive.");
    expect(produced).toContain("Hand-written prose below the markers that must also survive.");
    expect(produced).not.toContain("stale row");
    expect(produced).toContain("`patterns/thing.md`");
  });

  it("renders deterministically, in a total order over content", () => {
    const root = scaffoldOf(SCAFFOLD);
    migrateScaffold({ scaffoldRoot: root });
    const inventory = inventoryScaffold({ scaffoldRoot: root });
    const rows = rowsFor(inventory, "pattern");
    expect(rows.length).toBeGreaterThan(0);
    expect(renderGeneratedView(rows)).toBe(renderGeneratedView([...rows].reverse()));
    expect(findGeneratedRegion(renderGeneratedView(rows))).not.toBeNull();
  });

  it("keeps a CRLF file's terminators when it renders", () => {
    const rows = [{ id: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD" as never, type: "pattern" as const, title: "T", file: "patterns/t.md" }];
    const rendered = renderGeneratedView(rows, "\r\n");
    expect(/[^\r]\n/.test(rendered), "a lone LF in a block destined for a CRLF file").toBe(false);
  });

  it("finds nothing in a file with no markers, rather than inventing a region", () => {
    expect(findGeneratedRegion("# Plain\n\nNo markers here.\n")).toBeNull();
    expect(findGeneratedRegion(`${GENERATED_BEGIN}\nunterminated\n`)).toBeNull();
  });
});

describe("a dry run over the adversarial set", () => {
  it("skips a Team-owned path with a reason, and never abstains on one", () => {
    // A member file and an activity event are canonical Team artifacts. They
    // were being offered for classification, which meant migration printed them
    // under "left for a human to classify" while the operation layer would have
    // refused any plan that touched one — asking for a decision it would then
    // reject. Skipped with a reason is the honest outcome: an abstention says
    // nobody could decide, and here nobody was supposed to.
    const root = scaffoldOf({
      "team/members/member_x.md": FRONT() + "# A member\n\nProse.\n",
      "events/activity/2026-08/event_x.md": FRONT() + "# An event\n\nProse.\n",
      "playbooks/thing.md": FRONT() + "# A playbook\n\nProse.\n",
      "context/architecture.md": FRONT() + "# Architecture\n\nProse enough for a claim here.\n",
    });
    const report = planMigration({ scaffoldRoot: root });

    const skipped = new Map(report.filesSkipped.map((entry) => [entry.file, entry.reason]));
    for (const path of ["team/members/member_x.md", "events/activity/2026-08/event_x.md", "playbooks/thing.md"]) {
      expect(skipped.has(path), `${path} was not skipped`).toBe(true);
      expect(skipped.get(path)).toContain("Team-owned");
      expect(report.abstentions.some((entry) => entry.file === path), `${path} was abstained on`).toBe(false);
      expect(report.planned.some((entry) => entry.file === path), `${path} was planned`).toBe(false);
    }
    // Not vacuous: the ordinary file in the same scaffold still migrates, so a
    // classifier that refused everything would fail here.
    expect(report.planned.map((entry) => entry.file)).toEqual(["context/architecture.md"]);
  });

  it("writes nothing and reports every abstention", () => {
    const root = scaffoldOf({
      "context/stack.md": FRONT() + "# Stack\n\nProse.\n",
      "context/nested/deeper.md": FRONT() + "# Deeper\n\nProse.\n",
      "context/architecture.md":
        FRONT() + "# Architecture\n\nIntro.\n\n## Thin\n\nOne line.\n",
    });
    const before = snapshot(root);
    const report = planMigration({ scaffoldRoot: root });
    expect(snapshot(root)).toEqual(before);
    expect(report.abstentions.length).toBeGreaterThan(0);
    // Both shapes: a whole file no rule covers, and a section below the bar.
    expect(report.abstentions.some((entry) => entry.target === null)).toBe(true);
    expect(report.abstentions.some((entry) => entry.target?.at === "heading")).toBe(true);
  });
});
