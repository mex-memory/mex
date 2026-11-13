import { describe, expect, it } from "vitest";
import { assertPersonQuote, CheckSchema, KNOWLEDGE_LIMITS, parseEntry, serializeEntry, validateEntry, type KnowledgeEntry } from "../entry.js";

export function sample(): KnowledgeEntry {
  return {
    mex: {
      id: "mx_7f3k2a", kind: "recipe", scope: ["tests/**"],
      source: { type: "person", ref: "mex note 2026-11-13", quote: "Tests use fixtures because they are reproducible." },
      evidence: "person", one_line: "Tests use fixtures because they are reproducible.",
      checks: [], status: "active", created: "2026-11-13",
    }, text: "Tests use fixtures because they are reproducible.",
  };
}
const digest = `sha256:${"a".repeat(64)}`;
const observations = [
  { kind: "key", target: { file: "package.json", pointer: "/scripts/test" }, saw: { value: "vitest run" } },
  { kind: "command", target: { run: "npm test", file: "package.json", pointer: "/scripts/test" }, saw: { exists: true } },
  { kind: "section", target: { file: "CONTRIBUTING.md", heading: "Tests" }, saw: { hash: digest } },
  { kind: "source", target: { file: "README.md" }, saw: { hash: digest } },
  { kind: "source", target: { url: "https://example.test/docs" }, saw: { hash: digest } },
  { kind: "value", target: { file: "src/defaults.ts", symbol: "defaults" }, saw: { value: { methods: ["GET", "POST"], retries: 3, enabled: true, other: null } } },
  { kind: "symbol", target: { file: "src/router.ts", symbol: "Router.match" }, saw: { fingerprint: "mh2:64:recorded-fingerprint" } },
  { kind: "pattern", target: { scope: "src/**", pattern: "console.log", match: "literal" }, saw: { count: 0 } },
  { kind: "relation", target: { query: "imports", from: "core/**", to: "adapters/**" }, saw: { count: 0 } },
];
describe("entry-file v0", () => {
  it("round-trips the metadata and full text, including CRLF files", () => {
    const entry = sample();
    const encoded = serializeEntry(entry);
    expect(parseEntry(encoded)).toEqual(entry);
    expect(parseEntry(encoded.replace(/\n/g, "\r\n"))).toEqual(entry);
    expect(encoded).toMatch(/^---\nmex:\n/);
  });
  it.each(observations)("round-trips a $kind check without evaluating it", observation => {
    const entry = sample();
    entry.mex.checks = [CheckSchema.parse({ ...observation, role: "supporting", files: { "package.json": digest } })];
    expect(parseEntry(serializeEntry(entry))).toEqual(entry);
  });
  it.each(["verdict", "last_used", "delivery_count", "level", "triggers", "edges"])("rejects %s in tracked metadata", key => {
    const entry = sample();
    expect(() => validateEntry({ ...entry, mex: { ...entry.mex, [key]: "extra" } })).toThrow();
  });
  it("rejects an extra top-level frontmatter key", () => {
    expect(() => parseEntry(serializeEntry(sample()).replace("mex:\n", "unexpected: true\nmex:\n"))).toThrow();
  });
  it("requires the person's quote and verifies it against the original typed text", () => {
    const entry = sample();
    expect(() => assertPersonQuote(entry, `Please remember: ${entry.mex.source.quote}`)).not.toThrow();
    expect(() => assertPersonQuote(entry, "A model invented this instead.")).toThrow(/not found/);
    delete entry.mex.source.quote;
    expect(() => validateEntry(entry)).toThrow();
  });
  it("retains a team retirement record in the same format", () => {
    const entry = sample();
    entry.mex.status = "retired";
    expect(() => serializeEntry(entry)).toThrow();
    entry.mex.retired = { reason: "The test system changed", by: "maintainer", at: "2026-11-13" };
    expect(parseEntry(serializeEntry(entry))).toEqual(entry);
    entry.mex.status = "active";
    expect(() => serializeEntry(entry)).toThrow();
  });
  it.each(["2026-02-30", "2026-13-01", "2026-11-13T01:02:03Z"])("rejects a non-calendar date %s", created => {
    const entry = sample(); entry.mex.created = created;
    expect(() => serializeEntry(entry)).toThrow();
  });
  it.each(["../outside/**", "/outside/**", "C:/outside/**", "src/../outside", "src\\outside"])("rejects escaping scope %s", glob => {
    const entry = sample(); entry.mex.scope = [glob];
    expect(() => serializeEntry(entry)).toThrow();
  });
  it("rejects duplicate keys, aliases, custom tags and missing frontmatter", () => {
    const original = serializeEntry(sample());
    for (const invalid of [
      original.replace("  kind: recipe", "  kind: recipe\n  kind: rule"),
      original.replace("  scope:", "  scope: &scopes" ).replace("  checks: []", "  checks: *scopes"),
      original.replace("  kind: recipe", "  kind: !unknown recipe"),
      "A fact without frontmatter.",
    ]) expect(() => parseEntry(invalid)).toThrow();
  });
  it("rejects unbounded observations, unknown check fields, and bad pointers", () => {
    const base = { ...observations[0], role: "complete", files: {} };
    for (const invalid of [
      { ...base, target: { file: "../package.json", pointer: "/scripts/test" } },
      { ...base, target: { file: "package.json", pointer: "/bad~escape" } },
      { ...base, evaluated: true },
      { ...base, saw: { value: Infinity } },
      { ...base, saw: { value: Array.from({ length: 1025 }, () => 1) } },
    ]) expect(CheckSchema.safeParse(invalid).success).toBe(false);
  });
  it("bounds file input before YAML parsing and never truncates the short form", () => {
    expect(() => parseEntry("x".repeat(KNOWLEDGE_LIMITS.entryBytes + 1))).toThrow(/size/);
    const entry = sample(); entry.mex.one_line = "x".repeat(1025);
    expect(() => serializeEntry(entry)).toThrow();
  });
});
