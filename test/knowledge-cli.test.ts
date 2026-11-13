import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let root: string, repo: string, mexBase: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-knowledge-cli-")); repo = join(root, "repo"); mexBase = join(root, "user"); mkdirSync(repo);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(args: string[], cwd = repo, interactive = false) {
  const preload = "data:text/javascript,import https from 'node:https';import http from 'node:http';import{syncBuiltinESMExports}from 'node:module';const deny=()=>{throw new Error('Unexpected network')};https.request=deny;http.request=deny;globalThis.fetch=deny;syncBuiltinESMExports();Object.defineProperty(process.stderr,'isTTY',{value:true});";
  const result = spawnSync(process.execPath, [...(interactive ? ["--import", preload] : []), cli, ...args], {
    cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, MEX_HOME: mexBase, MEX_TELEMETRY: interactive ? "1" : "0", ...(interactive ? {
      DO_NOT_TRACK: "0", MEX_OFFLINE: "0", MEX_DEV: "", CI: "", CONTINUOUS_INTEGRATION: "", GITHUB_ACTIONS: "", GITLAB_CI: "", TF_BUILD: "", BUILDKITE: "", CIRCLECI: "", JENKINS_URL: "",
    } : {}), MEX_BACKGROUND: "0", NO_COLOR: "1" },
  });
  expect(result.error, result.stderr).toBeUndefined();
  return { ...result, json: () => JSON.parse(result.stdout) };
}
describe("shipped knowledge commands", () => {
  it("rejects invalid notes before telemetry can initialize storage", () => {
    for (const name of ["note", "log"]) {
      const result = run(["--no-open", name, "A fact.", "--scope", "../escape", "--json"], repo, true);
      expect(result.status).toBe(1); expect(result.stderr).toBe("");
      expect(result.json()).toMatchObject({ ok: false, error: { code: "INVALID_ENTRY" } });
      expect(existsSync(mexBase)).toBe(false);
    }
  });
  it("keeps reads noninitializing with global options and interactive telemetry enabled", () => {
    for (const leading of [["--no-open"], ["--port", "4321"]]) {
      const result = run([...leading, "recall", "fixtures", "--json"], repo, true);
      expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe("");
      expect(result.json()).toEqual({ ok: true, entries: [], truncated: false });
      expect(existsSync(mexBase)).toBe(false);
    }
    const missing = run(["--no-open", "expand", "mx_absent1", "--json"], repo, true);
    expect(missing.status).toBe(1); expect(missing.stderr).toBe("");
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(existsSync(mexBase)).toBe(false);
  });
  it("still shows the notice for an eligible interactive command after global options", () => {
    const result = run(["--no-open", "completion", "bash"], repo, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/MEX (collects|sends)/u);
    expect(JSON.parse(readFileSync(join(mexBase, ".mex", "config.json"), "utf8")).firstRunNoticeShown).toBe(true);
  });
  it("saves a complete entry, recalls its short form and expands its source", () => {
    const text = "Fixtures make tests reproducible because they use fixed data.";
    const saved = run(["note", text, "--kind", "recipe", "--scope", "test/**", "--scope", "src/**", "--json"]);
    expect(saved.status, saved.stderr).toBe(0); expect(saved.stderr).toBe("");
    const id = saved.json().entry.mex.id;
    expect(saved.json()).toMatchObject({ ok: true, level: "personal", entry: { mex: { scope: ["test/**", "src/**"], checks: [], source: { type: "person", quote: text }, evidence: "person" }, text } });
    const recalled = run(["recall", "TESTS fixed", "--json"]);
    expect(recalled.status, recalled.stderr).toBe(0); expect(recalled.stderr).toBe("");
    expect(recalled.json()).toMatchObject({ ok: true, entries: [{ id, one_line: text }], truncated: false });
    expect(recalled.json().entries[0]).not.toHaveProperty("entry");
    const expanded = run(["expand", id, "--json"]);
    expect(expanded.status, expanded.stderr).toBe(0);
    expect(expanded.json().entry).toEqual(saved.json().entry);
    expect(readdirSync(repo)).toEqual([]);
    expect(existsSync(join(mexBase, ".mex", "config.json"))).toBe(false);
  });
  it("works from a second real worktree with one shared MEX home", () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", timeout: 5000 });
    git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(repo, "README.md"), "# Fixture\n"); git("add", "README.md"); git("commit", "-m", "Fixture");
    const second = join(root, "second"); git("worktree", "add", "-b", "feature", second);
    const saved = run(["note", "Fixtures make tests reproducible.", "--json"]); expect(saved.status, saved.stderr).toBe(0);
    const recalled = run(["recall", "fixtures", "--json"], second); expect(recalled.status, recalled.stderr).toBe(0);
    expect(recalled.json().entries[0].id).toBe(saved.json().entry.mex.id);
    expect(git("status", "--porcelain").toString()).toBe("");
  });
  it("keeps log as the same note command, with human output and no scaffold", () => {
    const saved = run(["log", "Fixtures keep tests reproducible."]);
    expect(saved.status, saved.stderr).toBe(0); expect(saved.stdout).toContain("Saved personal note mx_");
    expect(saved.stdout).toContain("[you said,");
    const recalled = run(["recall", "fixtures"]);
    expect(recalled.status, recalled.stderr).toBe(0); expect(recalled.stdout).toContain("more: mex expand mx_");
    const id = /mx_[a-z0-9]+/u.exec(recalled.stdout)![0];
    expect(run(["expand", id]).stdout).toContain("  source:");
    expect(readdirSync(repo)).toEqual([]);
  });
  it("returns empty reads and controlled JSON errors without initializing storage", () => {
    const empty = run(["recall", "fixtures", "--json"]);
    expect(empty.status, empty.stderr).toBe(0); expect(empty.json()).toEqual({ ok: true, entries: [], truncated: false });
    for (const [args, code] of [
      [["expand", "mx_absent1", "--json"], "NOT_FOUND"],
      [["expand", "../escape", "--json"], "INVALID_ID"],
      [["recall", "fixtures", "--limit", "1.5", "--json"], "INVALID_LIMIT"],
      [["note", "A fact.", "--scope", "../escape", "--json"], "INVALID_ENTRY"],
    ] as const) {
      const result = run([...args]); expect(result.status).toBe(1); expect(result.stderr).toBe("");
      expect(result.json()).toMatchObject({ ok: false, error: { code } });
    }
    expect(existsSync(mexBase)).toBe(false); expect(readdirSync(repo)).toEqual([]);
  });
});
