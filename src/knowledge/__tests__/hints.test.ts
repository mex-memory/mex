import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmHint, expireHints, forgetHint, hintExpiresAt, hintStatus, readHints, refreshHints } from "../hints.js";
import { note, recall, expand } from "../store.js";
import { openRecordReadOnly, projectIdentity } from "../../record/index.js";
import { prepareTeamWrite, applyTeamWrite } from "../team.js";
import { parseEntry, serializeEntry } from "../entry.js";
import { MEMORY_LIMITS } from "../host-memory.js";

let root: string, repo: string, home: string, claude: string, codex: string, memory: string;
const start = "2026-01-31T12:00:00.000Z";
const clock = (value: string) => { vi.setSystemTime(new Date(value)); return new Date(value); };
const options = () => ({ projectPath: repo, home, userHome: join(root, "default-user"), env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex }, consumerAgent: "human", isNetwork: () => false });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe", timeout: 5000 });
function topic(name: string, text: string, at = new Date()): string {
  mkdirSync(memory, { recursive: true });
  const path = join(memory, name);
  writeFileSync(path, `---\nname: Fixture knowledge\ndescription: Deterministic test guidance\ntype: project\n---\n${text}\n`);
  utimesSync(path, at, at); return path;
}
function codexSummary(name: string, cwd: string, text: string, at = new Date(), version = "memories"): string {
  const directory = join(codex, version, "rollout_summaries"); mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.md`);
  writeFileSync(path, `thread_id: ${name}\nupdated_at: ${at.toISOString()}\nrollout_path: /not-read/transcript.jsonl\ncwd: ${cwd}\n\n# A task\n## Reusable knowledge\n- ${text}\n`);
  utimesSync(path, at, at); return path;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); clock(start);
  root = mkdtempSync(join(tmpdir(), "mex-memory-hints-")); repo = join(root, "repo"); home = join(root, "mex-home"); claude = join(root, "chosen-claude"); codex = join(root, "chosen-codex"); mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "README.md"), "# Fixture\n"); git(repo, "add", "README.md"); git(repo, "commit", "-m", "Fixture");
  memory = join(claude, "projects", repo.replace(/[^a-zA-Z0-9]/gu, "-"), "memory");
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe("read-only host memory hints", () => {
  it("honors both configured homes, scopes Codex memories and never changes host files", () => {
    const file = topic("fixtures.md", "Fixtures use fixed inputs because failures must reproduce.");
    const other = join(root, "other-project"); mkdirSync(other);
    const codexFile = codexSummary("our-thread", repo, "Build artifacts are disposable because source files are canonical.");
    codexSummary("foreign-thread", other, "FOREIGN_SENTINEL belongs to another repository.");
    const before = [file, codexFile].map(path => ({ path, bytes: readFileSync(path), mtime: statSync(path).mtimeMs, mode: statSync(path).mode }));
    expect(refreshHints(options()).imported).toBe(2);
    const entries = readHints(options()).entries;
    expect(entries).toHaveLength(2); expect(entries.every(item => item.label === "[hint, seen once]" && item.entry.mex.evidence === "observed" && item.entry.mex.checks.length === 0)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("FOREIGN_SENTINEL");
    for (const snapshot of before) { expect(readFileSync(snapshot.path)).toEqual(snapshot.bytes); expect(statSync(snapshot.path).mtimeMs).toBe(snapshot.mtime); expect(statSync(snapshot.path).mode).toBe(snapshot.mode); }
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, ".mex"))).toBe(false);
    const entry = entries[0].entry;
    expect(() => prepareTeamWrite(entry, options())).toThrow(/Unconfirmed/);
    expect(entry.mex).not.toHaveProperty("lastSeen"); expect(entry.mex).not.toHaveProperty("observations");
  });
  it("never shows a memory to its originating agent, including aliases and duplicate cross-host claims", () => {
    topic("fixtures.md", "Fixtures use fixed inputs because failures must reproduce.");
    codexSummary("one", repo, "Build artifacts are disposable because source files are canonical.");
    refreshHints(options());
    expect(readHints({ ...options(), consumerAgent: "codex" }).entries.map(item => item.origin)).toEqual(["claude-code"]);
    expect(readHints({ ...options(), consumerAgent: "claude" }).entries.map(item => item.origin)).toEqual(["codex"]);
    expect(readHints({ ...options(), consumerAgent: undefined }).entries).toEqual([]);
    codexSummary("two", repo, "Fixtures use fixed inputs because failures must reproduce."); refreshHints(options());
    expect(readHints({ ...options(), consumerAgent: "codex" }).entries).toEqual([]);
    expect(recall("fixtures", { ...options(), consumerAgent: "codex" }).entries).toEqual([]);
  });
  it("reads both Codex memory versions and consolidated task groups without importing ambiguous scope", () => {
    const directory = join(codex, "memories_v2"); mkdirSync(directory, { recursive: true });
    const body = `# Task Group: Build rules\nscope: fixture repository\n## Task 1\n### rollout_summary_files\n- one.md (cwd=${repo}, rollout_path=/never/read, updated_at=${start})\n## Reusable knowledge\n- Build outputs are disposable because source is canonical.\n`;
    writeFileSync(join(directory, "MEMORY.md"), body); utimesSync(join(directory, "MEMORY.md"), new Date(), new Date());
    mkdirSync(join(codex, "memories"), { recursive: true }); writeFileSync(join(codex, "memories/MEMORY.md"), body);
    refreshHints(options());
    expect(readHints(options()).entries).toHaveLength(1);
    expect(readHints(options()).entries[0].observations).toBe(1);
    writeFileSync(join(directory, "MEMORY.md"), body.replace("cwd=", "cwd=/foreign, other="));
    expect(readHints(options()).entries.length).toBeLessThanOrEqual(1);
  });
  it("checks source identity on every read and does not rewrite or initialize during reads", () => {
    expect(recall("fixtures", options()).entries).toEqual([]); expect(hintStatus(options()).active).toBe(0); expect(existsSync(home)).toBe(false);
    const file = topic("fixtures.md", "Fixtures use fixed input because failures must reproduce."); refreshHints(options());
    const entry = readHints(options()).entries[0];
    writeFileSync(file, "A different memory.");
    expect(readHints(options())).toMatchObject({ entries: [], withheld: 1 });
    expect(() => expand(entry.entry.mex.id, options())).toThrow(/No active/);
    expect(hintStatus(options()).active).toBe(1);
  });
  it("refuses linked sources and unknown formats, and reports bounded partial reading", () => {
    topic("safe.md", "Fixtures use fixed input because failures must reproduce.");
    const outside = join(root, "outside.md"); writeFileSync(outside, "PRIVATE_OUTSIDE_SENTINEL");
    symlinkSync(outside, join(memory, "linked.md"));
    const directory = join(codex, "memories"); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "MEMORY.md"), "Unknown future memory syntax\nPRIVATE_UNKNOWN_SENTINEL");
    const result = refreshHints(options()); expect(result.partial).toBe(true); expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(readHints(options()))).not.toMatch(/PRIVATE_(OUTSIDE|UNKNOWN)_SENTINEL/u);
    expect(readFileSync(outside, "utf8")).toBe("PRIVATE_OUTSIDE_SENTINEL");
  });
  it("shares the repository's Claude memory with a second worktree", () => {
    topic("fixtures.md", "Fixtures use fixed input because failures must reproduce."); refreshHints(options());
    const worktree = join(root, "second"); git(repo, "worktree", "add", "-b", "feature", worktree);
    expect(readHints({ ...options(), projectPath: worktree, consumerAgent: "codex" }).entries).toHaveLength(1);
  });
  it("refuses overlapping host and destination storage before opening a record writer", () => {
    const destination = join(home, "projects", projectIdentity(repo).id, "hints");
    mkdirSync(destination, { recursive: true }); mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ autoMemoryDirectory: destination }));
    const source = join(destination, "owned-by-host.md"); writeFileSync(source, "Fixtures use fixed input because failures must reproduce.\n");
    const before = readFileSync(source);
    expect(() => refreshHints(options())).toThrow(/separate directories/);
    expect(readFileSync(source)).toEqual(before); expect(existsSync(join(home, "record.db"))).toBe(false);
  });
  it("keeps host files intact when configuration changes to overlap existing hints", () => {
    topic("fixtures.md", "Fixtures use fixed input because failures must reproduce."); refreshHints(options());
    const id = readHints(options()).entries[0].entry.mex.id;
    const destination = join(home, "projects", projectIdentity(repo).id, "hints"), source = join(destination, `${id}.md`);
    const before = readFileSync(source);
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ autoMemoryDirectory: destination }));
    expect(() => confirmHint(id, { text: "A person confirms the fixture rule." }, options())).toThrow(/separate directories/);
    expect(() => forgetHint(id, "Remove the hint.", options())).toThrow(/separate directories/);
    clock("2027-01-01T00:00:00Z"); expect(() => expireHints(options())).toThrow(/separate directories/);
    expect(readFileSync(source)).toEqual(before);
  });
  it("withholds a host with invalid memory configuration instead of falling back to a different root", () => {
    topic("fixtures.md", "Fixtures use fixed input because failures must reproduce.");
    writeFileSync(join(claude, "settings.json"), "{broken");
    expect(refreshHints(options())).toMatchObject({ imported: 0, partial: true, agents: { "claude-code": "partial" } });
    expect(existsSync(home)).toBe(false);
  });
});

describe("hint lifecycle under a fake clock", () => {
  it("does not restart the lifetime when unchanged memory is merely read or refreshed", () => {
    topic("fixtures.md", "Fixtures use fixed input because failures must reproduce."); refreshHints(options());
    const id = readHints(options()).entries[0].entry.mex.id;
    clock("2026-06-30T12:00:00Z"); refreshHints(options());
    expect(readHints(options()).entries[0].observations).toBe(1);
    clock("2026-07-31T12:00:00Z");
    expect(expireHints(options()).expired).toBe(1);
    const path = join(home, "projects", projectIdentity(repo).id, "hints", `${id}.md`);
    expect(existsSync(path)).toBe(false);
    topic("fixtures.md", "Fixtures use fixed input because failures must reproduce.");
    refreshHints(options()); expect(readHints(options()).entries).toEqual([]);
    const reader = openRecordReadOnly(options())!; expect(reader.setting(projectIdentity(repo).id, `knowledge.retired.${id}`)).toBeDefined(); reader.close();
  });
  it("keeps a repeated hint, but never expires old personal or team entries", () => {
    const text = "Fixtures use fixed input because failures must reproduce.";
    topic("first.md", text); refreshHints(options());
    const personal = note({ text: "Personal fixtures remain until the person removes them." }, options(), new Date("2000-01-01"));
    const team = structuredClone(personal.entry); team.mex.id = "mx_oldteam1";
    const preview = prepareTeamWrite(team, options(), team.mex.source.quote); applyTeamWrite(preview, preview.revision, options(), team.mex.source.quote);
    clock("2026-06-01T12:00:00Z"); topic("repeat.md", text); refreshHints(options());
    clock("2026-08-01T12:00:00Z"); expect(expireHints(options()).expired).toBe(0);
    expect(readHints(options()).entries[0].label).toBe("[hint, seen 2 times]");
    expect(expand(personal.entry.mex.id, options()).entry.mex.created).toBe("2000-01-01");
    expect(expand(team.mex.id, options()).level).toBe("team");
  });
  it("honors a configured lifetime and clamps calendar month ends", () => {
    expect(new Date(hintExpiresAt(Date.parse(start), 1)).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    topic("fixtures.md", "Fixtures use fixed input because failures must reproduce."); refreshHints(options(), new Date(), 1);
    expect(hintStatus(options()).expiryMonths).toBe(1);
    clock("2026-03-01T12:00:00Z"); expect(expireHints(options()).expired).toBe(1);
    expect(() => refreshHints(options(), new Date(), 0)).toThrow(/between 1 and 120/);
  });
  it("turns an explicitly confirmed hint into a non-expiring personal note", () => {
    topic("fixtures.md", "Fixtures use fixed input because failures must reproduce."); refreshHints(options());
    const id = readHints(options()).entries[0].entry.mex.id;
    const confirmed = confirmHint(id, { text: "Fixtures use recorded input because seeds are insufficient." }, options());
    expect(confirmed.entry.mex.source).toMatchObject({ type: "person", quote: confirmed.entry.text });
    clock("2030-01-01T00:00:00Z"); expireHints(options());
    expect(expand(id, options()).level).toBe("personal"); expect(readHints(options()).entries).toEqual([]);
    expect(hintStatus(options()).confirmed).toBe(1);
  });
  it("keeps a forgotten hint hidden after both destination restoration and a new source observation", () => {
    const text = "Fixtures use fixed input because failures must reproduce.";
    topic("first.md", text); refreshHints(options());
    const hint = readHints(options()).entries[0], id = hint.entry.mex.id;
    expect(() => forgetHint(id, "gh\u200bp_" + "x".repeat(36), options())).toThrow(/possible secret/);
    forgetHint(id, "No longer applicable.", options());
    const path = join(home, "projects", projectIdentity(repo).id, "hints", `${id}.md`);
    writeFileSync(path, serializeEntry(hint.entry));
    clock("2026-02-01T12:00:00Z"); topic("again.md", text); codexSummary("another-agent", repo, text);
    refreshHints(options());
    expect(readHints(options()).entries).toEqual([]);
    expect(parseEntry(serializeEntry(hint.entry)).mex).not.toHaveProperty("lastSeen");
  });
  it("bounds source discovery and never imports a synthetic secret", () => {
    topic("secret.md", "A synthetic credential ghp_" + "x".repeat(36));
    for (let i = 0; i < MEMORY_LIMITS.files + 1; i++) topic(`empty-${i}.md`, "# Index only");
    const result = refreshHints(options()); expect(result.partial).toBe(true);
    expect(readHints(options()).entries).toEqual([]);
  });
});
