import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTeamWrite, applyTeamWrite, teamEntries } from "../team.js";
import { expand, note, recall } from "../store.js";
import { parseEntry, serializeEntry, type KnowledgeEntry } from "../entry.js";
import { KNOWLEDGE_PRIORITY } from "../labels.js";

let root: string, repo: string, home: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe", timeout: 5000 });
const options = () => ({ projectPath: repo, home, isNetwork: () => false });
const fact = (id: string, text = "Fixtures are reproducible because their inputs are fixed."): KnowledgeEntry => ({
  mex: { id, kind: "rule", scope: ["**"], source: { type: "person", ref: "person typed this fact", quote: text }, evidence: "person", one_line: text, checks: [], status: "active", created: "2026-11-14" }, text,
});
const save = (entry: KnowledgeEntry) => { const preview = prepareTeamWrite(entry, options(), entry.mex.source.quote); return applyTeamWrite(preview, preview.revision, options(), entry.mex.source.quote); };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-team-entries-")); repo = join(root, "repo"); home = join(root, "home"); mkdirSync(repo);
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  git("add", "package.json"); git("commit", "-m", "Fixture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("team entry storage", () => {
  it("previews without creating storage, then publishes only the reviewed file", () => {
    const entry = fact("mx_team001"), preview = prepareTeamWrite(entry, options(), entry.text);
    expect(preview.diff).toContain("new file mode");
    expect(existsSync(join(repo, ".mex"))).toBe(false); expect(existsSync(home)).toBe(false);
    expect(() => applyTeamWrite(preview, "wrong", options(), entry.text)).toThrow(/preview/i);
    expect(existsSync(join(repo, ".mex"))).toBe(false);
    expect(applyTeamWrite(preview, preview.revision, options(), entry.text).level).toBe("team");
    expect(expand(entry.mex.id, options())).toMatchObject({ level: "team", label: "[team, from a person]", entry });
    expect(existsSync(home)).toBe(false);
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });
  it("merges two independent branch additions without conflicts", () => {
    git("checkout", "-b", "one"); save(fact("mx_branch1")); git("add", ".mex/learned"); git("commit", "-m", "One entry");
    git("checkout", "main"); git("checkout", "-b", "two"); save(fact("mx_branch2")); git("add", ".mex/learned"); git("commit", "-m", "Another entry");
    git("checkout", "one"); git("merge", "--no-edit", "two");
    expect(recall("fixtures", options()).entries.map(item => item.id).sort()).toEqual(["mx_branch1", "mx_branch2"]);
    expect(existsSync(home)).toBe(false);
  });
  it("marks branch-only entries until their exact bytes reach the default branch", () => {
    save(fact("mx_team001"));
    expect(recall("fixtures", options()).entries[0].branch).toBe("branch");
    git("add", ".mex/learned"); git("commit", "-m", "Shared entry");
    expect(recall("fixtures", options()).entries[0].branch).toBe("default");
    save(fact("mx_team001", "Fixtures now use another seed because inputs changed."));
    expect(recall("fixtures", options()).entries[0].branch).toBe("branch");
  });
  it("keeps personal notes ahead of team entries and exposes the full precedence order", () => {
    save(fact("mx_team001"));
    const personal = note({ text: "Fixtures are personal because the person supplied them." }, options(), new Date("2020-01-01"));
    expect(recall("fixtures", options()).entries.map(item => item.id)).toEqual([personal.entry.mex.id, "mx_team001"]);
    expect(KNOWLEDGE_PRIORITY).toEqual(["current-request", "personal", "repo-instructions", "team", "hint"]);
  });
  it("keeps a team retirement and its reason in the original entry file", () => {
    const original = save(fact("mx_team001")).entry;
    const retired = { reason: "The rule changed.", by: "mex forget", at: "2026-11-14" };
    const preview = prepareTeamWrite({ ...original, mex: { ...original.mex, status: "retired", retired } }, options());
    applyTeamWrite(preview, preview.revision, options());
    const entry = parseEntry(readFileSync(join(repo, ".mex/learned/mx_team001.md"), "utf8"));
    expect(entry.mex).toMatchObject({ status: "retired", retired });
    expect(recall("fixtures", options()).entries).toEqual([]);
    expect(() => expand(original.mex.id, options())).toThrow(/No active/);
    expect(() => prepareTeamWrite(original, options(), original.text)).toThrow(/retired/);
  });
  it("refuses stale bytes and altered proposals instead of replacing a newer edit", () => {
    const original = save(fact("mx_team001")).entry;
    const next = fact("mx_team001", "Fixtures have stable seeds because failures must reproduce.");
    const preview = prepareTeamWrite(next, options(), next.text);
    expect(() => applyTeamWrite({ ...preview, after: serializeEntry(fact("mx_team001", "A different proposal.")) }, preview.revision, options(), "A different proposal.")).toThrow(/preview/i);
    const newer = fact("mx_team001", "Fixtures use recorded data because seeds are insufficient."); save(newer);
    expect(() => applyTeamWrite(preview, preview.revision, options(), next.text)).toThrow(/preview/i);
    expect(expand(original.mex.id, options()).entry.text).toBe(newer.text);
  });
  it("reads kind folders but refuses duplicate ids and redirected storage", () => {
    const entry = fact("mx_team001"); mkdirSync(join(repo, ".mex/learned/rule"), { recursive: true });
    writeFileSync(join(repo, ".mex/learned/rule/mx_team001.md"), serializeEntry(entry));
    expect(expand(entry.mex.id, options()).level).toBe("team");
    writeFileSync(join(repo, ".mex/learned/mx_team001.md"), serializeEntry(entry));
    expect(() => recall("fixtures", options())).toThrow(/more than one/);
    rmSync(join(repo, ".mex"), { recursive: true }); const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(repo, ".mex"), "junction");
    expect(() => recall("fixtures", options())).toThrow(/redirected/);
  });
  it("accepts actual repository CI evidence but refuses unconfirmed observations", () => {
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo, ".github/workflows/test.yml"), "jobs:\n  test:\n    steps:\n      - run: npm test\n");
    const entry = fact("mx_ci00001", "Tests run with `npm test` because CI uses the same script.");
    entry.mex.source = { type: "ci", ref: ".github/workflows/test.yml" }; entry.mex.evidence = "ci";
    expect(save(entry).label).toBe("[team, from CI]");
    entry.mex.id = "mx_hint001"; entry.mex.source = { type: "agent-memory", ref: "memory" }; entry.mex.evidence = "observed";
    expect(() => save(entry)).toThrow(/Unconfirmed/);
  });
  it("rechecks hand-edited files and withholds secrets without printing their contents", () => {
    save(fact("mx_team001"));
    const entry = fact("mx_team001", "A synthetic credential ghp_" + "x".repeat(36));
    writeFileSync(join(repo, ".mex/learned/mx_team001.md"), serializeEntry(entry));
    expect(teamEntries(options())).toEqual({ entries: [], withheld: 1 });
    expect(recall("credential", options())).toEqual({ entries: [], truncated: false, withheld: 1 });
    expect(() => expand(entry.mex.id, options())).toThrow(/possible secret/);
  });
});
