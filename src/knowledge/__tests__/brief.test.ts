import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewBrief } from "../brief.js";
import { knowledgeProject } from "../context.js";
import { forget } from "../mutations.js";
import { note } from "../store.js";

const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const roots: string[] = [];
afterAll(() => { for (const path of roots) rmSync(path, { recursive: true, force: true }); });

describe.skipIf(!enabled)("brief previews through the real native evaluator", () => {
  let binary: string;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "mex-brief-bin-")); roots.push(base);
    binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve(__dirname, "../../../native"), timeout: 240_000, stdio: "pipe" });
  }, 300_000);

  function fixture() {
    const base = mkdtempSync(join(tmpdir(), "mex-brief-")); roots.push(base);
    const root = join(base, "repo"), home = join(base, "home"); mkdirSync(root);
    execFileSync("git", ["init", "-q", root]);
    return { root, home, options: { projectPath: root, env: { ...process.env, MEX_HOME: home, MEX_HOOK_BINARY: binary } } };
  }

  it("reads an empty checkout without provisioning storage or a delivery ledger", () => {
    const { home, options } = fixture();
    const first = previewBrief(options, "codex");
    expect(first.text).toContain("Priority: current request");
    expect(first.token_bound).toBeLessThanOrEqual(300);
    expect(first.items).toEqual([]);
    expect(existsSync(home)).toBe(false);
    expect(previewBrief(options, "codex").text).toBe(first.text);
    expect(() => previewBrief(options, "codex", "../outside")).toThrow(/inside this checkout/);
    expect(() => previewBrief(options, "other")).toThrow(/claude-code or codex/);
  });

  it("shares Node's note identity and retirement state without changing the record", () => {
    const { options } = fixture();
    const saved = note({ text: "Keep commits small, because they are easier to review." }, options).entry;
    const project = knowledgeProject(options);
    const record = join(project.location.directory, "record.db");
    const before = readFileSync(record);
    const first = previewBrief(options, "codex");
    expect(first.items.map(item => item.id)).toContain(saved.mex.id);
    expect(readFileSync(record)).toEqual(before);
    expect(existsSync(join(project.location.directory, "hooks.db"))).toBe(false);
    // Retirement is in Node's record. Restoring old Markdown cannot revive it.
    forget(saved.mex.id, "No longer my preference.", options);
    expect(previewBrief(options, "claude-code").items).toEqual([]);
    expect(existsSync(join(project.location.directory, "hooks.db"))).toBe(false);
  });
});
