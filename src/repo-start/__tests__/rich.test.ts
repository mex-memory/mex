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
    expect(labelled("No test or build commands found in config")).toEqual({ label: "Commands", text: "none found in package files" });
    expect(labelled("Git history and the file index: in the background (`mex jobs`)").label).toBe("Your code");
    expect(labelled("MEX is off everywhere, so nothing was read or queued. `mex on --all` turns it back on.").label).toBe("MEX");
    expect(labelled("Something new")).toEqual({ label: "Note", text: "Something new" });
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
    const off = plain(rich.end(rich.summary({ name: "shop", ms: 900, commandsSaved: false, findings: [{ state: "attention", text: "MEX is off everywhere, so nothing was read or queued." }] }))).join("\n");
    expect(off).toContain("MEX is off everywhere, so I read nothing.");
    expect(off).not.toContain("Read shop");
  });

  it("uses 256 colours unless the terminal says it has truecolor", () => {
    expect(new Rich({}).fg("orange")).toBe("\x1b[38;5;173m");
    expect(new Rich({ COLORTERM: "truecolor" }).fg("orange")).toBe("\x1b[38;2;232;132;92m");
    expect(new Rich({ WT_SESSION: "1" }).fg("orange")).toBe("\x1b[38;2;232;132;92m");
  });
});

describe("setup v2 on the rich screen", () => {
  const rich = new Rich({}, 100);
  it("labels the code map and learn deeper like every other step", () => {
    expect(labelled("Code map built: 640 files, 4,210 definitions; 12 notes now checked by code fingerprint"))
      .toEqual({ label: "Code map", text: "640 files, 4,210 definitions · 12 notes now checked by code fingerprint" });
    expect(labelled("The code map was already current")).toEqual({ label: "Code map", text: "already current" });
    expect(labelled("Code map: building in the background (`mex jobs`)")).toEqual({ label: "Code map", text: "building in the background · mex jobs" });
    expect(labelled("The code map didn't finish: out of memory (`mex jobs`)").label).toBe("Code map");
    expect(labelled("Learn deeper queued. See `mex jobs` for progress.")).toEqual({ label: "Learn deeper", text: "queued. See `mex jobs` for progress." });
    expect(labelled("Learn deeper: no reviews to learn from (no GitHub or GitLab remote) · $0, nothing started").label).toBe("Learn deeper");
  });

  it("shows a question with its choices and keys, and names the agents in use", () => {
    expect(plain(rich.question({ index: 0, total: 2, text: "`packages/db` imports `@acme/ui` in 1 place. Is that allowed?",
      choices: [{ key: "1", label: "no, keep it one-way" }, { key: "2", label: "yes, it's allowed" }], suggested: "1" }))).toEqual([
      "   1/2 `packages/db` imports `@acme/ui` in 1 place. Is that allowed?",
      "   [1] no, keep it one-way  [2] yes, it's allowed  · Enter 1 · s skip · S skip all",
    ]);
    expect(plain(rich.question({ index: 1, total: 2, text: "Which?", choices: [{ key: "1", label: "a" }] }))[1]).toContain("Enter skips");
    expect(plain(rich.next({ agents: ["Claude Code", "Codex", "Gemini CLI"] })).join("\n"))
      .toContain("Notes you save reach every new Claude Code, Codex and Gemini CLI session.");
    const summary = plain(rich.summary({ name: "repo", ms: 1200, commandsSaved: true, findings: [], answers: 2, learning: "running" }));
    expect(summary).toContain('Your 2 answers reach them as "you said".');
    expect(summary).toContain("Learn deeper is running in the background · mex jobs");
  });

  it("never promises delivery when the hooks are the Node fallback, which delivers nothing", () => {
    const next = plain(rich.next({ agents: ["Claude Code"], hooksOff: true })).join("\n");
    expect(next).toContain("Nothing reaches your agents yet: MEX's native hook is missing. Reinstall MEX, then run mex install.");
    expect(next).not.toContain("Notes you save reach");
    const summary = plain(rich.summary({ name: "repo", ms: 1200, commandsSaved: true, findings: [], answers: 2, hooksOff: true }));
    expect(summary).toContain("Your agents get nothing yet: MEX's native hook is missing.");
    expect(summary.join("\n")).not.toMatch(/get its test and build commands|you said/u);
    expect(labelled("Hooks: Claude Code and Codex, in your user settings, but MEX's native hook is missing, so nothing reaches them yet. Reinstall MEX."))
      .toEqual({ label: "Hooks", text: "Claude Code and Codex · MEX's native hook is missing, so nothing reaches them yet. Reinstall MEX." });
  });
});
