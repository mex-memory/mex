import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shareRepo } from "../../knowledge/__tests__/share-fixtures.js";
import { knowledgeProject } from "../../knowledge/context.js";
import { buildUpgradeCommand } from "../cli.js";

const originalCwd = process.cwd();
afterEach(() => { process.chdir(originalCwd); process.exitCode = 0; vi.restoreAllMocks(); });
function fixture() {
  const f = shareRepo();
  mkdirSync(join(f.root, ".mex/context"), { recursive: true });
  writeFileSync(join(f.root, ".mex/context/rules.md"), "# Rules\nA cache is disposable because Markdown owns the knowledge.\n");
  writeFileSync(join(f.root, ".mex/SETUP.md"), "Obsolete setup.\n");
  f.git("add", "."); f.git("commit", "-qm", "old scaffold");
  process.chdir(f.root);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation(value => { lines.push(String(value)); });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return { ...f, lines };
}
describe("root upgrade command", () => {
  it("requires an exact preview, applies it, and preserves an existing telemetry opt-out", async () => {
    const f = fixture(), p = knowledgeProject({ projectPath: f.root });
    mkdirSync(p.location.home, { recursive: true });
    const disabled = join(p.location.home, "telemetry-disabled");
    writeFileSync(disabled, "off\n");
    await buildUpgradeCommand().parseAsync(["--json"], { from: "user" });
    const preview = JSON.parse(f.lines.at(-1)!) as { revision: string; ready: boolean; applied: boolean };
    expect(preview.ready).toBe(true); expect(preview.applied).toBe(false);
    expect(existsSync(p.location.record)).toBe(false);
    await buildUpgradeCommand().parseAsync(["--apply", "--expect", preview.revision, "--json"], { from: "user" });
    const result = JSON.parse(f.lines.at(-1)!) as { ok: boolean; applied: boolean; branch: string };
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(f.git("show", `${result.branch}:.mex/learned/`)).toContain("mx_");
    expect(readFileSync(disabled, "utf8")).toBe("off\n");
    await buildUpgradeCommand().parseAsync(["--json"], { from: "user" });
    expect(JSON.parse(f.lines.at(-1)!)).toMatchObject({ alreadyUpgraded: true, branch: result.branch });
  });
  it.each([{ flags: ["--pr"] }, { flags: ["--apply"] }, { flags: ["--finish", "--discard"] }, { flags: ["--expect", "unapproved"] }])("refuses incomplete or conflicting flags $flags", async ({ flags }) => {
    const f = fixture();
    await buildUpgradeCommand().parseAsync([...flags, "--json"], { from: "user" });
    expect(JSON.parse(f.lines.at(-1)!)).toMatchObject({ ok: false });
    expect(process.exitCode).toBe(1);
    expect(existsSync(knowledgeProject({ projectPath: f.root }).location.record)).toBe(false);
  });
});
