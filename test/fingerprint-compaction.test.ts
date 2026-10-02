import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactFingerprintsInText, compactScaffoldFingerprints } from "../src/fingerprint-compaction.js";
import { createFingerprint, deserializeFingerprint, serializeFingerprint } from "../src/graph/fingerprint.js";
import type { Fingerprint } from "../src/graph/reconcile.js";
import { extractGroundings } from "../src/markdown.js";
import type { MexConfig } from "../src/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fingerprint(seed: string): Fingerprint {
  return createFingerprint(
    ["FunctionKeyword", "Identifier", "OpenParenToken", "CloseParenToken", "OpenBraceToken", seed, "CloseBraceToken"],
    [`function:${"a".repeat(31)}${seed.length % 10}`],
    [`method:${"b".repeat(32)}`],
  );
}

/** The encoding every scaffold committed before #233. */
function hex(value: Fingerprint): string {
  return `mh:64:${Buffer.from(JSON.stringify(value), "utf8").toString("hex")}`;
}

const ROOT = fingerprint("Root");
const MAPPED = fingerprint("Mapped");
const BLOCK = fingerprint("BlockEntity");

/** A scaffold file with a grounding in each place one can live, each quoted differently. */
function document(fingerprints: { root: string; mapped: string; block: string }, eol = "\n"): string {
  return [
    "---",
    "name: architecture   # a comment that must survive",
    "grounds_to:",
    "  - node: \"function:11111111111111111111111111111111\"",
    `    fingerprint: ${fingerprints.root}`,
    "    bodyHash: aaaa",
    "mex:",
    "  id: mx_01M1M0CJ5C5XQV0HM5VM787WQS",
    "  type: architecture",
    "  grounds_to:",
    "    - node: \"function:22222222222222222222222222222222\"",
    `      fingerprint: "${fingerprints.mapped}"`,
    "---",
    "",
    "# Architecture",
    "",
    `Prose that quotes a fingerprint, ${fingerprints.root}, is not a grounding.`,
    "",
    "<!-- mex:entity",
    "id: mx_01M1M0CJ4PS8VVVJJTFA58S3A5",
    "type: component",
    "status: promoted",
    "revision: 1",
    "grounds_to:",
    "  - node: function:33333333333333333333333333333333",
    `    fingerprint: '${fingerprints.block}'`,
    "-->",
    "## System Overview",
    "",
    "Body.",
    "",
  ].join(eol);
}

describe("compactFingerprintsInText (#233)", () => {
  it("re-encodes every grounding list in place and changes no other byte", () => {
    for (const eol of ["\n", "\r\n"]) {
      const before = document({ root: hex(ROOT), mapped: hex(MAPPED), block: hex(BLOCK) }, eol);
      const result = compactFingerprintsInText(before);
      expect(result).toMatchObject({ compacted: 3, alreadyCompact: 0, undecodable: 0 });
      // Prose keeps the hex string it quotes; only the three groundings change.
      const expected = document({ root: serializeFingerprint(ROOT), mapped: serializeFingerprint(MAPPED), block: serializeFingerprint(BLOCK) }, eol)
        .replace(`fingerprint, ${serializeFingerprint(ROOT)}, is`, `fingerprint, ${hex(ROOT)}, is`);
      expect(result.text).toBe(expected);
      expect(result.text.length).toBeLessThan(before.length);
    }
  });

  it("keeps every grounding's fingerprint value", () => {
    const before = document({ root: hex(ROOT), mapped: hex(MAPPED), block: hex(BLOCK) });
    const after = compactFingerprintsInText(before).text;
    expect(extractGroundings(after).map((entry) => deserializeFingerprint(entry.fingerprint)))
      .toEqual(extractGroundings(before).map((entry) => deserializeFingerprint(entry.fingerprint)));
  });

  it("leaves compact and invalid values exactly as written, and is idempotent", () => {
    const text = document({ root: serializeFingerprint(ROOT), mapped: "mh:64:zz", block: hex(BLOCK) });
    const first = compactFingerprintsInText(text);
    expect(first).toMatchObject({ compacted: 1, alreadyCompact: 1, undecodable: 1 });
    expect(first.text).toContain("fingerprint: \"mh:64:zz\"");
    expect(compactFingerprintsInText(first.text)).toEqual({ text: first.text, compacted: 0, alreadyCompact: 2, undecodable: 1 });
  });

  it("returns a document with no groundings unchanged", () => {
    const text = "---\nname: plain\n---\n\n# Plain\n\nmh:64:00 in prose.\n";
    expect(compactFingerprintsInText(text)).toEqual({ text, compacted: 0, alreadyCompact: 0, undecodable: 0 });
  });
});

describe("compactScaffoldFingerprints (#233)", () => {
  function scaffold(): { config: MexConfig; context: string; team: string; teamText: string } {
    const root = mkdtempSync(join(tmpdir(), "mex-compact-fingerprints-"));
    roots.push(root);
    const scaffoldRoot = join(root, ".mex");
    mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
    mkdirSync(join(scaffoldRoot, "team"), { recursive: true });
    const context = join(scaffoldRoot, "context", "architecture.md");
    const team = join(scaffoldRoot, "team", "member.md");
    const teamText = document({ root: hex(ROOT), mapped: hex(MAPPED), block: hex(BLOCK) });
    writeFileSync(context, document({ root: hex(ROOT), mapped: hex(MAPPED), block: hex(BLOCK) }));
    writeFileSync(team, teamText);
    return { config: { projectRoot: root, scaffoldRoot, aiTools: [] }, context, team, teamText };
  }

  it("reports without writing on a dry run, then writes, then has nothing left to do", () => {
    const { config, context, team, teamText } = scaffold();
    const original = readFileSync(context, "utf-8");

    const dryRun = compactScaffoldFingerprints(config, { dryRun: true });
    expect(dryRun).toMatchObject({ dryRun: true, compacted: 3, skipped: [] });
    expect(dryRun.files).toEqual([
      expect.objectContaining({ file: ".mex/context/architecture.md", compacted: 3 }),
    ]);
    expect(readFileSync(context, "utf-8")).toBe(original);

    const applied = compactScaffoldFingerprints(config);
    expect(applied).toMatchObject({ dryRun: false, compacted: 3, skipped: [] });
    expect(readFileSync(context, "utf-8")).toBe(compactFingerprintsInText(original).text);

    expect(compactScaffoldFingerprints(config)).toMatchObject({ compacted: 0, alreadyCompact: 3, files: [] });
    // Team records are canonical exact-byte artifacts with their own writers.
    expect(readFileSync(team, "utf-8")).toBe(teamText);
  });
});
