import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../entry.js";
import { gateEntry, pullRepository } from "../gates.js";
import type { References } from "../references.js";
import { teamEntry } from "../team.js";

const refs = (links: string[] = []): References => ({
  root: ".", commands: new Set(), links: new Set(links), scripts: new Set(), packageScripts: new Map(), truncated: false,
} as References);

const hash = `sha256:${"a".repeat(64)}`;
const learned = (over: Partial<KnowledgeEntry["mex"]> = {}): KnowledgeEntry => ({
  mex: {
    id: `mx_deep${"b".repeat(32)}`, kind: "rule", scope: ["src/**"],
    source: { type: "review", ref: "https://github.com/acme/app/pull/12", producer: "learn-deeper",
      quote: "use the checked loader here", model: { id: "best", version: "test" }, label: "Learned from 2 PRs" },
    evidence: "review", one_line: "Use the checked loader for input.",
    checks: [
      { kind: "source", role: "supporting", target: { url: "https://github.com/acme/app/pull/12#discussion_r1" }, saw: { hash }, files: {} },
      { kind: "source", role: "supporting", target: { url: "https://github.com/acme/app/pull/40#discussion_r2" }, saw: { hash }, files: {} },
      { kind: "source", role: "supporting", target: { url: "https://github.com/other/app/pull/7" }, saw: { hash }, files: {} },
    ],
    status: "active", created: "2026-11-23", ...over,
  },
  text: "Read input through the checked loader. It validates the shape.",
});

describe("team writes of learned entries", () => {
  it("strips the kept quote and the local provenance, and keeps a person's own quote", () => {
    const team = teamEntry(learned());
    expect(team.mex.source).toEqual({ type: "review", ref: "https://github.com/acme/app/pull/12" });
    const person = teamEntry({ ...learned(), mex: { ...learned().mex, id: "mx_abcdef123456", source: { type: "person", ref: "note", quote: "we use the loader" }, evidence: "person" } });
    expect(person.mex.source.quote).toBe("we use the loader");
  });

  it("refuses to share a rule learned from typed text, whose quote must stay personal", () => {
    const entry = learned({ source: { type: "person", ref: "session", producer: "learn-deeper", quote: "always use the loader" }, evidence: "person" });
    expect(() => teamEntry(entry)).toThrow(/stays personal/u);
  });
});

describe("the shared gate and learned review links", () => {
  it("keeps the pull request checks from the entry's own repository and drops others", () => {
    const gated = gateEntry(teamEntry(learned()), refs());
    expect(gated.mex.checks.map(check => "url" in check.target ? check.target.url : "")).toEqual([
      "https://github.com/acme/app/pull/12#discussion_r1", "https://github.com/acme/app/pull/40#discussion_r2",
    ]);
  });

  it("drops unlisted links on entries that are not learned review rules", () => {
    const entry = learned({ id: "mx_abcdef123456", source: { type: "docs", ref: "README.md" }, evidence: "docs" });
    expect(gateEntry(entry, refs()).mex.checks).toEqual([]);
  });

  it("reads the repository from a pull request link only", () => {
    expect(pullRepository("https://github.com/acme/app/pull/12#discussion_r1")).toBe("https://github.com/acme/app");
    expect(pullRepository("https://github.com/acme/app/issues/12")).toBeUndefined();
    expect(pullRepository("https://example.com/acme/app/pull/12")).toBeUndefined();
  });
});
