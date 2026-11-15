import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, projectIdentity } from "../../record/index.js";
import { runOut } from "../command.js";
import { grepSaved, listSavedOutputs, readSavedOutput, SAVED_OUTPUT_VERSION, savedOutputDirectory } from "../saved.js";

const temps: string[] = [];
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "mex-out-")); temps.push(dir); return dir; }
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

/** Writes a saved output the way native/output/spill.go does. */
function save(directory: string, n: number, text: string, command = "npm test"): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${n}.txt`), text);
  writeFileSync(join(directory, `${n}.json`), JSON.stringify({ version: SAVED_OUTPUT_VERSION, n, command, exit_code: 0, agent: "claude-code", created_at: "2026-11-15T10:00:00Z", lines: text.split("\n").length - 1, chars: text.length }));
}

describe("saved output", () => {
  it("lists complete outputs newest first and reads them byte for byte", () => {
    const dir = temp();
    save(dir, 1, "one\n");
    save(dir, 2, "two\r\nlines\r\n", "go test ./...");
    writeFileSync(join(dir, "3.txt"), "still being written");
    expect(listSavedOutputs(dir).map((s) => s.n)).toEqual([2, 1]);
    expect(readSavedOutput(dir, 2)?.text).toBe("two\r\nlines\r\n");
    expect(readSavedOutput(dir, 3)).toBeUndefined();
    expect(readSavedOutput(dir, 0)).toBeUndefined();
  });

  it("greps with line numbers and context, and takes plain text that is not a valid pattern", () => {
    const text = "a\nb\nerror: c\nd\ne\nf\nwarn g\n";
    expect(grepSaved(text, "error|warn")).toEqual([{ line: 3, text: "error: c", match: true }, { line: 7, text: "warn g", match: true }]);
    expect(grepSaved(text, "ERROR", { ignoreCase: true, context: 1 }).map((l) => l.line)).toEqual([2, 3, 4]);
    expect(grepSaved("x (y\n", "(y")).toEqual([{ line: 1, text: "x (y", match: true }]);
  });

  it("refuses a project id that is not one", () => {
    expect(() => savedOutputDirectory("/tmp", "../../etc")).toThrow();
  });
});

describe("mex out", () => {
  it("lists, shows and greps the outputs of the folder's project", () => {
    const home = temp(); const project = temp();
    openRecord({ home, projectPath: project, isNetwork: () => false }).close();
    const dir = savedOutputDirectory(home, projectIdentity(project).id);
    save(dir, 7, "line 1\nFAIL src/a.test.ts\nline 3\n");
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    expect(runOut(undefined, { cwd: project, home }, write)).toBe(0);
    expect(lines.join("\n")).toContain("npm test");
    lines.length = 0;
    expect(runOut("7", { cwd: project, home }, write)).toBe(0);
    expect(lines).toEqual(["line 1\nFAIL src/a.test.ts\nline 3"]);
    lines.length = 0;
    expect(runOut("7", { cwd: project, home, grep: "FAIL" }, write)).toBe(0);
    expect(lines).toEqual(["2:FAIL src/a.test.ts"]);
    lines.length = 0;
    expect(runOut("7", { cwd: project, home, grep: "nothing" }, write)).toBe(1);
    expect(runOut("8", { cwd: project, home }, write)).toBe(1);
  });

  it("says so where MEX isn't on", () => {
    const home = temp(); const elsewhere = temp();
    openRecord({ home, isNetwork: () => false }).close();
    const lines: string[] = [];
    expect(runOut(undefined, { cwd: elsewhere, home }, (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toContain("isn't on");
  });
});
