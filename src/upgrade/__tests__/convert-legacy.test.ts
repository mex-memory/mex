import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { convertLegacy } from "../convert-legacy.js";
import type { LegacyDocument, LegacySnapshot } from "../legacy-reader.js";
import { parseWikiMarkdown } from "../../wiki/markdown/contract.js";
import { KNOWLEDGE_LIMITS, serializeEntry } from "../../knowledge/entry.js";
import { selectNative } from "../../knowledge/native-select.js";
import { canonicalFingerprint, deserializeFingerprint } from "../../graph/fingerprint.js";
import { K } from "../../graph/config.js";

const ID = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TODAY = "2026-11-15";
function document(text: string, kind: LegacyDocument["kind"] = "context", path = ".mex/context/conventions.md"): LegacyDocument {
  return { path, text, kind, bytes: Buffer.byteLength(text), hash: `sha256:${createHash("sha256").update(text).digest("hex")}`, parsed: parseWikiMarkdown({ path: path.replace(/^\.mex\//u, ""), text }) };
}
function snapshot(...documents: LegacyDocument[]): LegacySnapshot {
  return { present: true, complete: true, documents, logRows: [], retained: [], excluded: [], diagnostics: [] };
}
function wiki(extra = "", body = "The cache is disposable because Markdown owns the knowledge.", status = "promoted") {
  return `---\nmex:\n  id: ${ID}\n  type: convention\n  status: ${status}\n${extra}---\n# Source heading\n${body}\n`;
}

describe("legacy conversion candidates", () => {
  it("preserves inherited identity, authored source and historical date", () => {
    const input = snapshot(document(wiki("  title: Display title\n  provenance:\n    createdBy: {kind: human, id: original-author}\n    createdAt: 2026-10-01T10:00:00Z\n")));
    const before = JSON.stringify(input);
    const result = convertLegacy(input, TODAY);
    expect(result.issues).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const converted = result.candidates[0];
    expect(converted.source).toEqual({ path: ".mex/context/conventions.md", entityId: ID });
    expect(converted.entry.mex).toMatchObject({ id: ID.toLowerCase(), kind: "rule", created: "2026-10-01",
      source: { type: "docs", ref: ".mex/context/conventions.md" }, evidence: "docs" });
    expect(converted.entry.mex.source.quote).toBeUndefined();
    expect(converted.entry.mex.checks[0]).toMatchObject({ kind: "section", target: { heading: "Source heading" } });
    expect(converted.entry.text).toBe("The cache is disposable because Markdown owns the knowledge.");
    expect(JSON.stringify(input)).toBe(before);
    expect(convertLegacy(input, TODAY)).toEqual(result);
  });

  it("uses the migration date when the source does not record an original date", () => {
    const result = convertLegacy(snapshot(document(wiki())), TODAY);
    expect(result.candidates[0].entry.mex.created).toBe(TODAY);
  });

  it("keeps deprecated knowledge retired", () => {
    const result = convertLegacy(snapshot(document(wiki("", "This older recipe is kept for history.", "deprecated"))), TODAY);
    expect(result.candidates[0].entry.mex).toMatchObject({ status: "retired", retired: { reason: "Imported legacy status: deprecated", by: "mex upgrade", at: TODAY } });
  });

  it("imports logged decisions as unchecked documentation, without inventing a typed quote", () => {
    const input = snapshot();
    const path = ".mex/events/decisions.jsonl";
    input.log = { path, text: "retained original log", hash: "sha256:" + "a".repeat(64), bytes: 21 };
    input.logRows = [
      { line: 1, value: { kind: "decision", message: "Keep the shared pool open.", timestamp: "2026-10-03T10:00:00Z", actor: "someone", cwd: "/private/source" } },
      { line: 2, value: { kind: "note", message: "Not a recorded decision.", timestamp: "2026-10-04T10:00:00Z" } },
    ];
    const result = convertLegacy(input, TODAY);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].entry).toMatchObject({ text: "Keep the shared pool open.", mex: {
      kind: "decision", source: { type: "docs", ref: path }, checks: [], created: "2026-10-03" } });
    expect(JSON.stringify(result.candidates)).not.toContain("/private/source");
    expect(result.candidates[0].source).toEqual({ path, line: 1 });
    expect(convertLegacy(input, TODAY).candidates[0].entry.mex.id).toBe(result.candidates[0].entry.mex.id);
  });

  it("keeps router rows and obsolete workflow instructions out of delivered knowledge", () => {
    const input = snapshot(document(wiki(), "router", ".mex/ROUTER.md"), document("old setup", "obsolete", ".mex/SETUP.md"));
    const result = convertLegacy(input, TODAY);
    expect(result.candidates).toEqual([]);
    expect(result.preserved).toEqual([".mex/ROUTER.md", ".mex/SETUP.md"]);
  });

  it("uses the existing rule-file conversion for unadopted human rules and recipes", () => {
    const text = "# Rules\nKeep mutations explicit.\n\n## Pitfalls\nA stale cache cannot prove the current source.\n\n<!-- mex-agent:skills:start -->\nObsolete wiki instructions.\n<!-- mex-agent:skills:end -->\n";
    const result = convertLegacy(snapshot(document(text, "instructions", "AGENTS.md")), TODAY);
    expect(result.issues).toEqual([]);
    expect(result.candidates.map(item => item.entry.mex.kind)).toEqual(["rule", "pitfall"]);
    expect(JSON.stringify(result.candidates)).not.toContain("Obsolete wiki instructions");
    expect(result.candidates.every(item => item.entry.mex.source.type === "rule-file")).toBe(true);
  });

  it.each([".mex/context/conventions.md", ".mex/patterns/cache.md", ".mex/AGENTS.md"])("lets checked imported rules from %s reach agents after the old router stops loading them", path => {
    const result = convertLegacy(snapshot(document("# Cache rule\nThe cache is disposable because Markdown owns the knowledge.\n", "context", path)), TODAY);
    expect(result.issues).toEqual([]);
    const entry = result.candidates[0].entry;
    expect(entry.mex.source).toEqual({ type: "docs", ref: path });
    expect(selectNative([{ level: "team", entry }], new Map([[`team/${entry.mex.id}`, "held" as const]])).selected).toHaveLength(1);
  });

  it("preserves legacy grounding baselines without inventing current file hashes", () => {
    const source = document(wiki("  grounds_to:\n    - node: function:12345678abcdefab\n      fingerprint: mh:2:0123456789abcdef\n      bodyHash: historical-body\n      codeHash: historical-code\n      file: src/api.ts\n    - node: class:abcdefab12345678\n      fingerprint: mh2:64:Original_CASE\n"));
    const result = convertLegacy(snapshot(source), TODAY);
    expect(result.issues).toEqual([]);
    expect(result.candidates[0].entry.mex.checks.slice(1)).toEqual([
      { kind: "legacy-grounding", role: "supporting", target: { node: "function:12345678abcdefab", file: "src/api.ts" },
        saw: { fingerprint: "mh:2:0123456789abcdef", bodyHash: "historical-body", codeHash: "historical-code" }, files: {} },
      { kind: "legacy-grounding", role: "supporting", target: { node: "class:abcdefab12345678" }, saw: { fingerprint: "mh2:64:Original_CASE" }, files: {} },
    ]);
    expect(source.parsed.entities[0].entity.groundsTo[0].bodyHash).toBe("historical-body");
  });

  it("keeps an entry whose 0.8 fingerprint is longer than a line, in its compact lossless form", () => {
    // A real 0.8 `mh:` fingerprint: hex of JSON, the minhash values and the neighbour ids.
    const value = { minhash: Array.from({ length: K }, (_, i) => 4_000_000_000 - i * 7919), neighbors: Array.from({ length: 12 }, (_, i) => `function:${String(i).padStart(32, "a")}`), tokenCount: 420 };
    const long = `mh:${K}:${Buffer.from(JSON.stringify(value)).toString("hex")}`;
    expect(long.length).toBeGreaterThan(2048);
    const result = convertLegacy(snapshot(document(wiki(`  grounds_to:\n    - node: function:12345678abcdefab\n      fingerprint: ${long}\n`))), TODAY);
    expect(result.issues).toEqual([]);
    const saw = result.candidates[0].entry.mex.checks.find(check => check.kind === "legacy-grounding")?.saw as { fingerprint: string };
    expect(saw.fingerprint).toBe(canonicalFingerprint(long));
    expect(saw.fingerprint.startsWith("mh2:")).toBe(true);
    expect(deserializeFingerprint(saw.fingerprint)).toEqual(value);
  });

  it("reports oversized prose for review instead of truncating it", () => {
    const source = document(wiki("", "A".repeat(9000)));
    const result = convertLegacy(snapshot(source), TODAY);
    expect(result.candidates).toEqual([]);
    expect(result.issues.some(issue => issue.code === "ENTRY_NEEDS_REVIEW")).toBe(true);
    expect(source.text).toContain("A".repeat(9000));
  });

  it("refuses conversion from a partial read", () => {
    const source = snapshot(document(wiki()));
    source.complete = false;
    expect(convertLegacy(source, TODAY)).toEqual({ candidates: [], preserved: [], issues: [{ code: "INCOMPLETE_LEGACY_INPUT", path: ".mex" }] });
  });

  it("bounds imported output by the destination store's byte budget", () => {
    const input = snapshot();
    input.log = { path: ".mex/events/decisions.jsonl", text: "source retained", bytes: 15, hash: "sha256:" + "a".repeat(64) };
    const message = "A complete claim.\n\n" + "A".repeat(7900);
    input.logRows = Array.from({ length: 1100 }, (_, index) => ({ line: index + 1,
      value: { kind: "decision", message, timestamp: "2026-10-03T10:00:00Z" } }));
    const result = convertLegacy(input, TODAY);
    expect(result.issues.some(issue => issue.code === "CONVERSION_LIMIT")).toBe(true);
    expect(result.candidates.length).toBeLessThan(input.logRows.length);
    expect(result.candidates.reduce((bytes, item) => bytes + Buffer.byteLength(serializeEntry(item.entry)), 0)).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.scanBytes);
    expect(result.candidates[0].entry.text).toBe(message);
  });

  it("bounds review diagnostics without hiding the fact that some were omitted", () => {
    const input = snapshot(...Array.from({ length: 110 }, (_, index) => {
      const id = ID.slice(0, -4) + index.toString(16).toUpperCase().padStart(4, "0");
      return document(wiki("", "A".repeat(9000)).replace(ID, id), "context", `.mex/context/${index}.md`);
    }));
    const result = convertLegacy(input, TODAY);
    expect(result.candidates).toEqual([]);
    expect(result.issues).toHaveLength(100);
    expect(result.issues.at(-1)?.code).toBe("CONVERSION_LIMIT");
  });

  it("keeps 0.8's setup templates and navigation for people instead of importing them as rules", () => {
    const templates = [
      document("# Patterns\n\n## How many patterns to generate\nDo not use a fixed number.\n", "pattern", ".mex/patterns/README.md"),
      document("# Pattern Index\n\n| Pattern | Use when |\n| --- | --- |\n| add-x.md | adding x |\n", "pattern", ".mex/patterns/INDEX.md"),
      document("# [Project Name]\n\n## What This Is\nLength: 1 sentence maximum.\n", "wiki", ".mex/.tool-configs/CLAUDE.md"),
    ];
    const result = convertLegacy(snapshot(...templates), TODAY);
    expect(result.candidates).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.preserved).toEqual([".mex/.tool-configs/CLAUDE.md", ".mex/patterns/INDEX.md", ".mex/patterns/README.md"]);
  });

  it("imports project instructions but not the retired 0.8 workflow sections", () => {
    const text = "# Hono\n\n## What This Is\nA small web framework on Web Standard APIs.\n\n## Commands\n- Test: `npm test`\n\n"
      + "## Code Graph\nUse `mex graph query who-calls <symbol>`.\n\n## Scaffold Growth\nAfter meaningful work, run GROW.\n\n"
      + "## Navigation\nAt the start of every session, read ROUTER.md before doing anything else.\n\n## Agent Logging\nRead `mex logging --json`.\n";
    const result = convertLegacy(snapshot(document(text, "instructions", ".mex/AGENTS.md")), TODAY);
    expect(result.candidates.map(c => c.entry.mex.one_line.split(":")[0]).sort()).toEqual(["Commands", "What This Is"]);
  });

  it("imports a 0.8 pattern as one procedure, without its scaffold-upkeep step", () => {
    const text = "# Add Route Group\n\n## Context\nRoutes are copied when `app.route()` runs.\n\n## Steps\n1. Build the sub-app as its own `new Hono()`.\n2. Mount it.\n\n"
      + "## Gotchas\n- Add routes before mounting.\n\n## Update Scaffold\n- [ ] Update `.mex/ROUTER.md`.\n";
    const result = convertLegacy(snapshot(document(text, "pattern", ".mex/patterns/add-route-group.md")), TODAY);
    expect(result.candidates).toHaveLength(1);
    const { entry } = result.candidates[0];
    expect(entry.mex).toMatchObject({ kind: "procedure", one_line: "Add Route Group: Routes are copied when `app.route()` runs." });
    expect(entry.mex.checks[0]).toMatchObject({ kind: "section", target: { heading: "Add Route Group" } });
    expect(entry.text).toContain("## Steps\n1. Build the sub-app as its own `new Hono()`.");
    expect(entry.text).toContain("## Gotchas");
    expect(entry.text).not.toContain("Update Scaffold");
    expect(entry.text).not.toContain("ROUTER.md");
  });

  it("imports each task of a multi-task pattern as its own procedure", () => {
    const text = "# Middleware\n\n## Task: Add middleware\nCreate a factory.\n\n### Steps\n1. Export it.\n\n## Task: Order middleware\nRegister in order.\n";
    const result = convertLegacy(snapshot(document(text, "pattern", ".mex/patterns/middleware.md")), TODAY);
    expect(result.candidates.map(c => c.entry.mex.one_line)).toEqual(["Add middleware: Create a factory.", "Order middleware: Register in order."]);
    expect(new Set(result.candidates.map(c => c.entry.mex.id)).size).toBe(2);
  });

  it("writes LF entry text from a CRLF (Windows autocrlf) checkout", () => {
    const crlf = wiki("", "First line.\nSecond line.").replace(/\n/gu, "\r\n");
    const { entry } = convertLegacy(snapshot(document(crlf)), TODAY).candidates[0];
    expect(entry.text).toBe("First line.\nSecond line.");
    expect(serializeEntry(entry)).not.toContain("\r");
  });

  it("writes a one-line summary from the claim, not a heading, list marker or record label", () => {
    const decision = wiki("", "**Date:** 2023-05-09\n**Status:** Active\n**Decision:** `hono/tiny` uses the pattern router only.\n**Reasoning:** Size.");
    expect(convertLegacy(snapshot(document(decision)), TODAY).candidates[0].entry.mex.one_line).toBe("`hono/tiny` uses the pattern router only.");
    const listed = wiki("", "## Overview\n- No runtime dependencies.\n- No database.");
    expect(convertLegacy(snapshot(document(listed)), TODAY).candidates[0].entry.mex.one_line).toBe("No runtime dependencies.");
  });
});
