import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeEntry } from "../src/knowledge/entry.js";

const cli = join(__dirname, "..", "dist", "cli.js");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeAll(() => { if (!existsSync(cli)) throw new Error("dist/cli.js is missing — run `npm run build` first."); });

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

function repo(): { root: string; env: NodeJS.ProcessEnv } {
  const base = mkdtempSync(join(tmpdir(), "mex-rules-cli-"));
  dirs.push(base);
  const root = join(base, "repo");
  execFileSync("git", ["init", "-q", "repo"], { cwd: base });
  git(root, "config", "user.email", "t@example.test"); git(root, "config", "user.name", "T");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, "README.md"), "# Demo\n");
  mkdirSync(join(root, ".mex", "learned"), { recursive: true });
  const text = "Releases go through the release workflow, because tags trigger publishing.";
  writeFileSync(join(root, ".mex", "learned", "mx_team01.md"), serializeEntry({
    mex: { id: "mx_team01", kind: "rule", scope: ["**"], source: { type: "docs", ref: "README.md" }, evidence: "docs", one_line: text, checks: [], status: "active", created: "2026-11-15" },
    text,
  }));
  const env = { ...process.env, MEX_HOME: join(base, "home"), MEX_TELEMETRY: "0", MEX_BACKGROUND: "1" };
  return { root, env };
}
const mex = (root: string, env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });

describe("rule files from the command line", { timeout: 120_000 }, () => {
  it("mex rules --write writes them; a team edit changes them in the same working-tree change", () => {
    const { root, env } = repo();
    let run = mex(root, env, "rules", "--write");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("wrote    .claude/rules/mex.md");
    git(root, "add", "."); git(root, "commit", "-qm", "base");

    const text = "Releases go through the release workflow, because a tag starts publishing.";
    run = mex(root, env, "edit", "mx_team01", text, "--json");
    const revision = (JSON.parse(run.stdout) as { preview: { revision: string } }).preview.revision;
    run = mex(root, env, "edit", "mx_team01", text, "--apply", "--expect", revision);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Rule files updated in the same change: .claude/rules/mex.md");
    const changed = git(root, "status", "--porcelain").split("\n").filter(Boolean).map(l => l.slice(3)).sort();
    // The entry, the rule file and the manifest of generated files: one change.
    expect(changed).toEqual([".claude/rules/mex.md", ".mex/learned/mx_team01.md", ".mex/native.json"]);
    expect(readFileSync(join(root, ".claude/rules/mex.md"), "utf8")).toContain("a tag starts publishing");
  });
});
