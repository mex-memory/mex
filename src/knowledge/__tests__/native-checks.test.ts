import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recordCheck, runNative } from "../check.js";
import { knowledgeProject } from "../context.js";
import { serializeEntry, type EntryCheck } from "../entry.js";
import { rebuildNative } from "../native.js";
import { prepareShare } from "../share-plan.js";
import { discardShare, pendingShare, runShare } from "../share.js";
import { note } from "../store.js";
import { entry } from "./fixtures.js";

const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"]).status === 0;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!enabled)("current checks before publication", () => {
  let binary: string;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "mex-native-check-bin-")); roots.push(base);
    binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve(__dirname, "../../../native"), timeout: 240_000, stdio: "pipe" });
  }, 300_000);

  function fixture() {
    const base = mkdtempSync(join(tmpdir(), "mex-native-check-")); roots.push(base);
    const root = join(base, "repo"); mkdirSync(root); execFileSync("git", ["init", "-q", root]);
    vi.stubEnv("MEX_HOME", join(base, "home"));
    mkdirSync(join(root, ".claude")); mkdirSync(join(root, ".mex/learned"), { recursive: true });
    const file = join(root, "package.json");
    writeFileSync(file, JSON.stringify({ scripts: { test: "vitest" } }));
    const check = recordCheck(binary, { checkout: root, kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }) as EntryCheck;
    writeFileSync(join(root, ".mex/learned/mx_checked.md"), serializeEntry(entry("mx_checked", {
      checks: [check], source: { type: "docs", ref: "package.json" }, evidence: "docs",
    }, "The test script uses vitest.")));
    return { root, file, check, options: { projectPath: root, env: { ...process.env, MEX_HOOK_BINARY: binary } } };
  }

  it("withholds a newly broken claim and removes its old generated text after source drift", () => {
    const { root, file, options } = fixture();
    writeFileSync(file, JSON.stringify({ scripts: { test: "other" } }));
    expect(rebuildNative(options).selected).toBe(0);
    expect(existsSync(join(root, ".claude/rules/mex.md"))).toBe(false);
    writeFileSync(file, JSON.stringify({ scripts: { test: "vitest" } }));
    expect(rebuildNative(options).selected).toBe(1);
    writeFileSync(file, JSON.stringify({ scripts: {} }));
    expect(rebuildNative(options).removed).toContain(".claude/rules/mex.md");
  });

  it("keeps imported legacy baselines unknown and out of generated rules in the real binary", () => {
    const f = fixture();
    const compatibility: EntryCheck = { kind: "legacy-grounding", role: "supporting", target: { node: "function:12345678abcdefab", file: "src/api.ts" },
      saw: { fingerprint: "mh2:64:Original_CASE", bodyHash: "old-body" }, files: {} };
    const original = serializeEntry(entry("mx_checked", { checks: [f.check, compatibility], source: { type: "docs", ref: "package.json" }, evidence: "docs" }, "The original imported rule remains unresolved."));
    writeFileSync(join(f.root, ".mex/learned/mx_checked.md"), original);
    for (const source of ["export const api = 1", "export const api = 2"]) {
      mkdirSync(join(f.root, "src"), { recursive: true }); writeFileSync(join(f.root, "src/api.ts"), source);
      const report = runNative(binary, { action: "evaluate", checkout: f.root, store: false, team_only: true });
      expect(report.items?.[0].verdict).toBe("unknown");
      expect(report.results?.[0].checks.at(-1)).toMatchObject({ kind: "legacy-grounding", status: "floor", reason: "legacy grounding needs review" });
      expect(rebuildNative(f.options).selected).toBe(0);
      expect(existsSync(join(f.root, ".claude/rules/mex.md"))).toBe(false);
      expect(readFileSync(join(f.root, ".mex/learned/mx_checked.md"), "utf8")).toBe(original);
    }
  });

  it("requires current proof for checked entries when the evaluator is unavailable", () => {
    const { root, options } = fixture();
    expect(rebuildNative({ ...options, env: { ...options.env, MEX_HOOK_BINARY: join(root, "missing-binary") } }).selected).toBe(0);
    expect(existsSync(join(root, ".claude/rules/mex.md"))).toBe(false);
  });

  function checkedNote(f: ReturnType<typeof fixture>) {
    const saved = note({ text: "Tests here run through the vitest script." }, f.options).entry;
    const project = knowledgeProject(f.options);
    writeFileSync(join(project.location.home, "projects", project.projectId, "notes", `${saved.mex.id}.md`),
      serializeEntry({ ...saved, mex: { ...saved.mex, checks: [f.check] } }));
    return saved.mex.id;
  }

  function commitBase(f: ReturnType<typeof fixture>) {
    const git = (...args: string[]) => execFileSync("git", ["-C", f.root, ...args], { stdio: "pipe" });
    // A person sharing has a Git identity; CI runners have none of their own.
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    git("add", ".");
    git("commit", "-qm", "base");
    git("branch", "-M", "main");
    return git;
  }

  it("rechecks personal claims before offering them for sharing", () => {
    const f = fixture(); commitBase(f);
    const id = checkedNote(f);
    expect(prepareShare(f.options).share.map(item => item.id)).toContain(id);
    writeFileSync(f.file, JSON.stringify({ scripts: {} }));
    expect(prepareShare(f.options).share.map(item => item.id)).not.toContain(id);
  });

  it("rejects a claim that holds on the working branch but fails on the share base", () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ scripts: { test: "other" } }));
    const git = commitBase(f);
    git("checkout", "-qb", "feature");
    writeFileSync(f.file, JSON.stringify({ scripts: { test: "vitest" } }));
    const id = checkedNote(f);
    const now = new Date("2026-11-15T12:00:00Z");
    const plan = prepareShare(f.options, { now });
    expect(plan.share.map(item => item.id)).toContain(id);
    expect(() => runShare(f.options, plan.revision, { now })).toThrow(/checks do not hold on the default branch/);
    const state = pendingShare(f.options)!;
    expect(existsSync(join(state.worktree, ".mex/learned", `${id}.md`))).toBe(false);
    discardShare(f.options);
  });

  it("does not let a personal copy's held checks authorize the team's broken copy", () => {
    const { root, file, options } = fixture();
    writeFileSync(file, JSON.stringify({ scripts: { test: "other", lint: "eslint" } }));
    const check = recordCheck(binary, { checkout: root, kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/lint" } }) as EntryCheck;
    const project = knowledgeProject(options);
    const notes = join(project.location.home, "projects", project.projectId, "notes");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "mx_checked.md"), serializeEntry(entry("mx_checked", {
      checks: [check], source: { type: "docs", ref: "package.json" }, evidence: "docs",
    }, "The lint script uses eslint.")));
    expect(rebuildNative(options).selected).toBe(1);
    expect(existsSync(join(root, ".claude/rules/mex.md"))).toBe(false);
    expect(existsSync(join(root, ".claude/rules/mex-local.md"))).toBe(true);
  });
});
