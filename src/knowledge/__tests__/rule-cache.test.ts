import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { serializeEntry } from "../entry.js";
import { formatRules, readRuleFiles, refreshRuleFiles } from "../rule-cache.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
  const base = mkdtempSync(join(tmpdir(), "mex-rule-cache-"));
  roots.push(base);
  const root = join(base, "repo");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  vi.stubEnv("MEX_HOME", join(base, "home"));
  writeFileSync(join(root, "CLAUDE.md"), "# Testing\n\nRun `npm test` first.\n\n## Lint\n\nRun `npm run lint`.\n");
  writeFileSync(join(root, "AGENTS.md"), "# Testing\n\nRun `npm test` before pushing.\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  return root;
}

describe("the saved rule-file scan", () => {
  it("is written per project and read back without scanning", () => {
    const root = repo();
    expect(readRuleFiles({ projectPath: root })).toBeUndefined();
    const saved = refreshRuleFiles({ projectPath: root }, new Date("2026-11-15T10:00:00Z"));
    const read = readRuleFiles({ projectPath: root })!;
    expect(read.entries.map(e => e.entry.mex.id)).toEqual(saved.entries.map(e => e.entry.mex.id));
    expect(read.entries[0].entry.mex.created).toBe("2026-11-15");
    const text = formatRules(read);
    expect(text).toContain("2 rule files, 3 entries");
    expect(text).toContain("CLAUDE.md  2 entries · loaded by claude-code");
    expect(text).toContain("conflict AGENTS.md, CLAUDE.md (Testing)");
    expect(text).toContain('"npm run lint"');
  });
});

// The Go evaluator must agree with the section hash written here.
const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
describe.skipIf(!enabled)("section checks against the Go evaluator", () => {
  it("every check written from a rule file holds there", () => {
    const root = repo();
    writeFileSync(join(root, ".cursorrules"), "Preamble only.\n");
    mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(root, ".cursor", "rules", "ts.mdc"), "---\nglobs: src/**\n---\n# TS\n\nStrict.\n\nSetext\n------\n\nBody.\n");
    const cache = refreshRuleFiles({ projectPath: root });
    const dir = mkdtempSync(join(tmpdir(), "mex-hook-bin-"));
    roots.push(dir);
    const binary = join(dir, `mex-hook${process.platform === "win32" ? ".exe" : ""}`);
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve(__dirname, "../../../native"), timeout: 240_000, stdio: "pipe" });
    mkdirSync(join(root, ".mex", "learned"), { recursive: true });
    for (const e of cache.entries) writeFileSync(join(root, ".mex", "learned", `${e.entry.mex.id}.md`), serializeEntry(e.entry));
    const out = spawnSync(binary, ["--check-run"], { input: JSON.stringify({ action: "evaluate", checkout: root, team_only: true }), encoding: "utf8" });
    const report = JSON.parse(out.stdout) as { items: Array<{ id: string; verdict: string }> };
    expect(report.items.length).toBe(cache.entries.length);
    expect(report.items.filter(i => i.verdict !== "held")).toEqual([]);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("Testing");
  }, 300_000);
});
