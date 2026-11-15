import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recordCheck } from "../check.js";
import { knowledgeProject } from "../context.js";
import { serializeEntry, type EntryCheck } from "../entry.js";
import { rebuildNative } from "../native.js";
import { entry } from "./fixtures.js";

const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"]).status === 0;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!enabled)("current checks before native publication", () => {
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
    return { root, file, options: { projectPath: root, env: { ...process.env, MEX_HOOK_BINARY: binary } } };
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

  it("requires current proof for checked entries when the evaluator is unavailable", () => {
    const { root, options } = fixture();
    expect(rebuildNative({ ...options, env: { ...options.env, MEX_HOOK_BINARY: join(root, "missing-binary") } }).selected).toBe(0);
    expect(existsSync(join(root, ".claude/rules/mex.md"))).toBe(false);
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
