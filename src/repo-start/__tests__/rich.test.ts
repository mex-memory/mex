import { describe, expect, it } from "vitest";
import { labelled, Rich } from "../rich.js";

const plain = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/gu, "").trimEnd());

describe("the rich first screen", () => {
  it("puts each finding in plain words under a short label", () => {
    expect(labelled("Test and build commands for 7 packages (build @a/core first); 2 CI steps need secrets or services · your agents get these from now on"))
      .toEqual({ label: "Commands", text: "test and build for 7 packages · build @a/core first · 2 CI steps need secrets or services" });
    expect(labelled("5 lines in your rule files are out of date")).toEqual({ label: "Out of date", text: "5 lines in your rule files" });
    expect(labelled("1 rule file read (CLAUDE.md); they agree")).toEqual({ label: "Rule files", text: "1 read · CLAUDE.md" });
    expect(labelled("Indexed 507 files")).toEqual({ label: "Your code", text: "507 files indexed" });
    expect(labelled("Git history (52 commits): no files change together often enough yet, 8 layer rules")).toEqual({ label: "Git history", text: "52 commits read" });
    expect(labelled("Hooks: Claude Code and Codex, in your user settings.")).toEqual({ label: "Hooks", text: "Claude Code and Codex" });
    expect(labelled("Something new")).toEqual({ label: "", text: "Something new" });
  });

  it("names the file once and lists the stale lines under it, after the rule files row", () => {
    const rich = new Rich({}, 100);
    const lines = plain(rich.rows([
      { state: "attention", text: "2 lines in your rule files are out of date", details: [
        "docs/CLAUDE.md:19  `.mex/mex.db`: file not found", "docs/CLAUDE.md:81  `engine/contract.ts`: file not found", "… and 3 more: mex rules"] },
      { state: "ok", text: "1 rule file read (docs/CLAUDE.md)" },
    ]));
    expect(lines[0]).toMatch(/✓ Rule files\s+1 read · docs\/CLAUDE\.md$/u);
    expect(lines[1]).toMatch(/! Out of date\s+2 lines in docs\/CLAUDE\.md$/u);
    expect(lines[2]).toMatch(/^\s+19 {2}\.mex\/mex\.db {9}file not found$/u);
    expect(lines[3]).toMatch(/^\s+81 {2}engine\/contract\.ts {2}file not found$/u);
    expect(lines[4]).toMatch(/\+ 3 more · mex rules$/u);
  });

  it("ends with the mascot saying what the run found", () => {
    const rich = new Rich({}, 100);
    const end = plain(rich.end(rich.summary({ name: "shop", ms: 6400, commandsSaved: true, findings: [{ state: "attention", text: "5 lines in your rule files are out of date" }] })));
    const text = end.join("\n");
    expect(text).toContain("Read shop in 6.4 s, for $0.");
    expect(text).toContain("Your agents now get its test and build commands.");
    expect(text).toContain("5 lines in your rule files are out of date.");
    expect(text).toContain("undo mex off this repo · mex uninstall everything");
    expect(rich.mascot()).toHaveLength(6);
    expect(plain(rich.mascot()).every(line => line.length <= 16)).toBe(true);
    const calm = plain(rich.end(rich.summary({ name: "shop", ms: 900, commandsSaved: false, findings: [] }))).join("\n");
    expect(calm).toContain("Nothing needs a look. You're set.");
  });

  it("uses 256 colours unless the terminal says it has truecolor", () => {
    expect(new Rich({}).fg("orange")).toBe("\x1b[38;5;173m");
    expect(new Rich({ COLORTERM: "truecolor" }).fg("orange")).toBe("\x1b[38;2;232;132;92m");
    expect(new Rich({ WT_SESSION: "1" }).fg("orange")).toBe("\x1b[38;2;232;132;92m");
  });
});
