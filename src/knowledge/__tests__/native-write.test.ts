import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { planNative } from "../native-plan.js";
import type { Candidate } from "../native-select.js";
import { excludeFile, writeNative } from "../native-write.js";
import { entry } from "./fixtures.js";
import { fileHash } from "../sections.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function setup(): { root: string; project: string } {
  const base = mkdtempSync(join(tmpdir(), "mex-native-"));
  dirs.push(base);
  const root = join(base, "repo"), project = join(base, "home", "projects", "g-x");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", "repo"], { cwd: base });
  writeFileSync(join(root, "CLAUDE.md"), "# Ours\n");
  return { root, project };
}
const team = (id: string, scope = "**"): Candidate => ({ level: "team", entry: entry(id, { scope: [scope] }, `Rule ${id}.`) });
const mine = (id: string): Candidate => ({ level: "personal", entry: entry(id, {}, `Note ${id}.`) });
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const status = (root: string) => execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });

describe("writing native files", () => {
  it("writes Copilot's path-scoped instructions alongside Claude Code's rules", () => {
    const { root, project } = setup();
    const result = writeNative(planNative(root, ["claude-code", "copilot"], [team("mx_root01"), team("mx_api001", "apps/api/**"), mine("mx_note01")]), { root, projectDirectory: project });
    expect(result.written).toEqual(expect.arrayContaining([".github/instructions/mex.instructions.md"]));
    expect(read(root, ".github/instructions/mex.instructions.md")).toContain("Rule mx_root01.");
    // A rebuild reads its own manifest back, Copilot's paths included.
    expect(() => writeNative(planNative(root, ["claude-code", "copilot"], [team("mx_root01")]), { root, projectDirectory: project })).not.toThrow();
  });

  it("refuses a manifest path outside the checkout without removing its target", () => {
    const { root, project } = setup();
    const outside = join(root, "..", "AGENTS.md"), text = "<!-- mex:generated -->\nOutside rule.\n";
    writeFileSync(outside, text);
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex/native.json"), JSON.stringify({ version: 1, files: { "../AGENTS.md": fileHash(text) } }));
    expect(() => writeNative({ files: [], notes: [] }, { root, projectDirectory: project })).toThrow();
    expect(readFileSync(outside, "utf8")).toBe(text);
  });

  it("refuses cleanup through a linked parent", () => {
    const { root, project } = setup();
    const outside = join(root, "..", "outside"), text = "<!-- mex:generated -->\nOutside rule.\n";
    mkdirSync(outside); writeFileSync(join(outside, "AGENTS.md"), text);
    try { symlinkSync(outside, join(root, "api"), process.platform === "win32" ? "junction" : "dir"); } catch { return; }
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex/native.json"), JSON.stringify({ version: 1, files: { "api/AGENTS.md": fileHash(text) } }));
    expect(() => writeNative({ files: [], notes: [] }, { root, projectDirectory: project })).toThrow();
    expect(readFileSync(join(outside, "AGENTS.md"), "utf8")).toBe(text);
  });

  it("keeps an edited generated file when its ownership manifest is missing", () => {
    const { root, project } = setup();
    const text = "<!-- mex:generated -->\nMy edited rule.\n";
    writeFileSync(join(root, "AGENTS.md"), text);
    const result = writeNative(planNative(root, ["codex"], [team("mx_rule01")]), { root, projectDirectory: project });
    expect(read(root, "AGENTS.md")).toBe(text);
    expect(result.kept).toContain("AGENTS.md");
  });

  it("never writes personal content into a tracked generated file", () => {
    const { root, project } = setup();
    writeNative(planNative(root, ["claude-code"], [mine("mx_note01")]), { root, projectDirectory: project });
    const path = ".claude/rules/mex-local.md", before = read(root, path);
    execFileSync("git", ["-C", root, "add", "-f", "--", path]);
    const result = writeNative(planNative(root, ["claude-code"], [mine("mx_note02")]), { root, projectDirectory: project });
    expect(read(root, path)).toBe(before);
    expect(result.kept).toContain(path);
    expect(result.written).toEqual([]);
  });

  it("does not publish personal rules when its exclude file cannot be safely updated", () => {
    const { root, project } = setup();
    const outside = join(root, "..", "outside-exclude.txt");
    writeFileSync(outside, "Keep this file.\n");
    unlinkSync(excludeFile(root)!);
    try { symlinkSync(outside, excludeFile(root)!); } catch { return; }
    expect(() => writeNative(planNative(root, ["claude-code"], [mine("mx_note01")]), { root, projectDirectory: project })).toThrow();
    expect(existsSync(join(root, ".claude/rules/mex-local.md"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("Keep this file.\n");
  });
  it("writes, reuses, then removes its own files when entries go", () => {
    const { root, project } = setup();
    let out = writeNative(planNative(root, ["claude-code"], [team("mx_a00001"), team("mx_b00001", "apps/api/**")]), { root, projectDirectory: project });
    expect(out.written.sort()).toEqual([".claude/rules/mex-area-apps-api-b3013059e312.md", ".claude/rules/mex.md"]);
    expect(JSON.parse(read(root, ".mex/native.json")).files).toHaveProperty([".claude/rules/mex.md"]);
    out = writeNative(planNative(root, ["claude-code"], [team("mx_a00001"), team("mx_b00001", "apps/api/**")]), { root, projectDirectory: project });
    expect(out.unchanged.length).toBe(2);
    out = writeNative(planNative(root, ["claude-code"], [team("mx_a00001")]), { root, projectDirectory: project });
    expect(out.removed).toEqual([".claude/rules/mex-area-apps-api-b3013059e312.md"]);
    expect(existsSync(join(root, ".claude/rules/mex-area-apps-api-b3013059e312.md"))).toBe(false);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
  });

  it("never overwrites or deletes a generated file a person edited", () => {
    const { root, project } = setup();
    writeNative(planNative(root, ["claude-code"], [team("mx_a00001")]), { root, projectDirectory: project });
    writeFileSync(join(root, ".claude/rules/mex.md"), `${read(root, ".claude/rules/mex.md")}- My own line.\n`);
    let out = writeNative(planNative(root, ["claude-code"], [team("mx_a00001"), team("mx_c00001")]), { root, projectDirectory: project });
    expect(out.kept).toEqual([".claude/rules/mex.md"]);
    expect(read(root, ".claude/rules/mex.md")).toContain("My own line.");
    out = writeNative(planNative(root, ["claude-code"], []), { root, projectDirectory: project });
    expect(out.kept).toEqual([".claude/rules/mex.md"]);
    expect(existsSync(join(root, ".claude/rules/mex.md"))).toBe(true);
  });

  it("solo: local files are written and hidden from git, and unhidden when they go", () => {
    const { root, project } = setup();
    writeNative(planNative(root, ["claude-code"], [mine("mx_n00001")]), { root, projectDirectory: project });
    expect(read(root, ".claude/rules/mex-local.md")).toContain("Note mx_n00001.");
    expect(readFileSync(excludeFile(root)!, "utf8")).toContain("/.claude/rules/mex-local.md");
    expect(status(root)).not.toContain("mex-local");
    expect(existsSync(join(root, ".mex/native.json"))).toBe(false);
    writeNative(planNative(root, ["claude-code"], []), { root, projectDirectory: project });
    expect(existsSync(join(root, ".claude/rules/mex-local.md"))).toBe(false);
    expect(readFileSync(excludeFile(root)!, "utf8")).not.toContain("mex-local");
  });

  it("keeps the person's own exclude lines", () => {
    const { root, project } = setup();
    writeFileSync(excludeFile(root)!, "# mine\n*.log\n");
    writeNative(planNative(root, ["claude-code"], [mine("mx_n00001")]), { root, projectDirectory: project });
    writeNative(planNative(root, ["claude-code"], []), { root, projectDirectory: project });
    expect(readFileSync(excludeFile(root)!, "utf8")).toBe("# mine\n*.log\n");
  });
});
