import { describe, expect, it } from "vitest";
import { formatSeconds, LiveLine, progressLine, renderDone, renderScreen, renderNext, NOTE_EXAMPLE, screenMode, wrap, type ScreenModel } from "../screen.js";
import { resultFindings } from "../finish.js";
import type { JobRow } from "../../record/jobs.js";
import { detectCaller, isAgentCaller } from "../caller.js";
import { LEARNING_BACKGROUND_NOTICE } from "../../filter/background-notice.js";

const model: ScreenModel = {
  name: "novu", ms: 2412, costUsd: 0, hidden: true,
  findings: [
    { state: "ok", text: "Test and build commands for 12 packages (build @novu/dal first) · your agents get these from now on" },
    { state: "ok", text: "21 notes from your Claude and Codex memory" },
    { state: "background", text: "The file index: in the background (`mex jobs`)" },
  ],
  notes: ["Hooks: Claude Code and Codex, in your user settings."],
};
const ANSI = /\x1b\[/u;

describe("screen mode", () => {
  it.each([
    ["no terminal", { stdoutTTY: false, env: {} }, true],
    ["NO_COLOR", { stdoutTTY: true, columns: 120, env: { NO_COLOR: "1" } }, true],
    ["empty NO_COLOR is not set", { stdoutTTY: true, columns: 120, env: { NO_COLOR: "" } }, false],
    ["TERM=dumb", { stdoutTTY: true, columns: 120, env: { TERM: "dumb" } }, true],
    ["40 columns", { stdoutTTY: true, columns: 40, env: {} }, true],
    ["80 columns", { stdoutTTY: true, columns: 80, env: {} }, false],
  ] as const)("%s → plain %s", (_name, input, plain) => {
    expect(screenMode({ ...input, platform: "darwin" }).plain).toBe(plain);
  });

  it("uses ASCII marks in a legacy Windows console but keeps colour", () => {
    const legacy = screenMode({ stdoutTTY: true, columns: 120, env: {}, platform: "win32" });
    expect(legacy).toMatchObject({ plain: false, ascii: true, color: true });
    expect(screenMode({ stdoutTTY: true, columns: 120, env: { WT_SESSION: "x" }, platform: "win32" }).ascii).toBe(false);
  });
});

describe("the first screen", () => {
  it("renders the rich form at 120 columns", () => {
    const lines = renderScreen(model, screenMode({ stdoutTTY: true, columns: 120, env: {}, platform: "darwin" }));
    expect(lines.map(line => line.replace(/\x1b\[[0-9;]*m/gu, ""))).toEqual([
      "MEX · novu · 2.4 s · $0 · nothing added to git",
      "",
      "  ✓ Test and build commands for 12 packages (build @novu/dal first) · your agents get these from now on",
      "  ✓ 21 notes from your Claude and Codex memory",
      "  ◌ The file index: in the background (`mex jobs`)",
      "  Hooks: Claude Code and Codex, in your user settings.",
    ]);
    expect(lines.some(line => ANSI.test(line))).toBe(true);
  });

  it("renders plain ASCII lines with no colour when there is no terminal", () => {
    expect(renderScreen(model, screenMode({ stdoutTTY: false, env: {}, platform: "darwin" }))).toEqual([
      "MEX - novu - 2.4 s - $0 - nothing added to git",
      "ok Test and build commands for 12 packages (build @novu/dal first) · your agents get these from now on",
      "ok 21 notes from your Claude and Codex memory",
      ".. The file index: in the background (`mex jobs`)",
      "Hooks: Claude Code and Codex, in your user settings.",
    ]);
  });

  it.each([40, 59])("wraps to a %i-column window with a hanging indent and no colour", (columns) => {
    const lines = renderScreen(model, screenMode({ stdoutTTY: true, columns, env: {}, platform: "darwin" }));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(columns);
      expect(ANSI.test(line)).toBe(false);
    }
    const first = lines.findIndex(line => line.startsWith("ok Test"));
    expect(lines[first + 1]!.startsWith("   ")).toBe(true);
  });

  it("breaks the header only between its parts and indents what runs on, like notes", () => {
    const lines = renderScreen(model, screenMode({ stdoutTTY: true, columns: 40, env: {}, platform: "darwin" }));
    expect(lines.slice(0, 2)).toEqual(["MEX - novu - 2.4 s - $0", "    nothing added to git"]);
    const note = lines.findIndex(line => line.startsWith("Hooks:"));
    expect(lines.slice(note)).toEqual(["Hooks: Claude Code and Codex, in your", "    user settings."]);
    const long = renderScreen({ ...model, name: "n".repeat(60) }, screenMode({ stdoutTTY: true, columns: 40, env: {}, platform: "darwin" }));
    for (const line of long) expect(line.length).toBeLessThanOrEqual(40);
    expect(long[0]).toBe("MEX");
    expect(long[1]!.startsWith("    n")).toBe(true);
  });

  it("wraps the rich form too and never exceeds the width with NO_COLOR at 80 columns", () => {
    const narrow = { ...model, findings: [{ state: "ok" as const, text: "x".repeat(200) }] };
    for (const line of renderScreen(narrow, screenMode({ stdoutTTY: true, columns: 80, env: { NO_COLOR: "1" }, platform: "darwin" }))) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("claims nothing was added to git only when the block is in place", () => {
    const [header] = renderScreen({ ...model, hidden: false }, screenMode({ stdoutTTY: false, env: {} }));
    expect(header).toBe("MEX - novu - 2.4 s - $0");
  });

  it("draws a live progress line with a bar that never wraps, ASCII in a legacy console", () => {
    const rich = screenMode({ stdoutTTY: true, columns: 80, env: {}, platform: "darwin" });
    const plainText = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");
    expect(plainText(progressLine("Indexing files", "4,210 of 12,306 files", 4210 / 12306, 0, rich)))
      .toBe("  ⠋ Indexing files  ━━━━━━━─────────────  4,210 of 12,306 files");
    const legacy = screenMode({ stdoutTTY: true, columns: 80, env: {}, platform: "win32" });
    expect(plainText(progressLine("Indexing files", undefined, 0.5, 1, legacy))).toBe("  / Indexing files  ##########----------");
    const narrow = screenMode({ stdoutTTY: true, columns: 60, env: {}, platform: "darwin" });
    expect(plainText(progressLine("Reading git history", "a very long detail ".repeat(5), 0.2, 3, narrow)).length).toBeLessThan(60);
    const written: string[] = [];
    const line = new LiveLine(rich, text => written.push(text));
    line.start("Indexing files"); line.update("1 of 2 files", 0.5); line.stop();
    expect(written.every(text => text.startsWith("\r\x1b[2K"))).toBe(true);
    expect(written.at(-1)).toBe("\r\x1b[2K");
    expect(renderDone(8_400, screenMode({ stdoutTTY: false, env: {} }))).toEqual(["Done in 8.4 s - $0"]);
  });

  it("says what the finished work found, or why it didn't finish", () => {
    const row = (kind: string, state: string, results = 0, reason: string | null = null) => ({ kind, state, results, reason }) as unknown as JobRow;
    const facts = { version: 1 as const, built_at: "", head: "a", commits_read: 1200, skipped: null, layer_rules: [{ from: "a", to: "b", imports: 3 }], generated: [],
      change_together: [{ a: "x.ts", b: "y.ts", confidence: 1, support: 4, kind: "related" as const }, { a: "y.ts", b: "x.ts", confidence: 1, support: 4, kind: "related" as const }] };
    expect(resultFindings([row("file-index", "done", 11582), row("code-facts", "done")], facts)).toEqual([
      { state: "ok", text: "Indexed 11,582 files" },
      { state: "ok", text: "Git history (1,200 commits): 1 file pair changes together, 1 layer rule" },
    ]);
    expect(resultFindings([row("file-index", "failed", 0, "disk full")], undefined)).toEqual([
      { state: "attention", text: "The file index didn't finish: disk full (`mex jobs`)" },
    ]);
    expect(resultFindings([row("code-facts", "done")], { ...facts, skipped: "no commits", change_together: [], layer_rules: [] })).toEqual([
      { state: "ok", text: "Git history: no commits yet" },
    ]);
  });

  it("formats measured time", () => {
    expect(formatSeconds(80)).toBe("0.1 s");
    expect(formatSeconds(12_600)).toBe("13 s");
    expect(wrap("short", undefined, 2)).toEqual(["short"]);
  });
});

describe("caller", () => {
  it("tells an agent from a script from a person", () => {
    expect(detectCaller({ env: { CLAUDECODE: "1" }, stdinTTY: true, stdoutTTY: true })).toBe("agent");
    expect(detectCaller({ env: { CODEX_THREAD_ID: "t" }, stdinTTY: false, stdoutTTY: false })).toBe("agent");
    expect(detectCaller({ env: {}, stdinTTY: false, stdoutTTY: true })).toBe("script");
    expect(detectCaller({ env: { CI: "true" }, stdinTTY: true, stdoutTTY: true })).toBe("script");
    expect(detectCaller({ env: { TERM: "dumb" }, stdinTTY: true, stdoutTTY: true })).toBe("script");
    expect(detectCaller({ env: {}, stdinTTY: true, stdoutTTY: true })).toBe("person");
    expect(isAgentCaller({ CLAUDECODE: "0" })).toBe(false);
  });
});

describe("what happens next", () => {
  const plain = screenMode({ stdoutTTY: false, env: {} });
  it("keeps agent and piped output short", () => {
    expect(renderNext({ short: true }, plain)).toEqual(['Saved notes reach new sessions; mex note "<fact>" adds one.', LEARNING_BACKGROUND_NOTICE]);
  });
  it("defaults learning to off and explains how to turn it on and how to undo", () => {
    const text = renderNext({ short: false }, plain).join("\n");
    expect(text).toContain("Learning from everything you type is off until you turn it on: mex config set learning.statements on");
    expect(text).toContain(LEARNING_BACKGROUND_NOTICE);
    expect(text).toContain("Undo: mex off (this repo) - mex uninstall (everything)");
    expect(renderNext({ short: false, learning: "off" }, plain).join("\n")).toBe(text);
  });
  it("discloses the background model and its cap once learning is on", () => {
    const text = renderNext({ short: false, learning: "on" }, plain).join("\n");
    expect(text).toContain("at most 3% of your usage");
    expect(text).toContain("mex config set learning.statements off");
    expect(text).toContain(LEARNING_BACKGROUND_NOTICE);
  });
  it.each([40, 80])("wraps instructions and inline details at %i columns", columns => {
    const mode = screenMode({ stdoutTTY: true, columns, env: {}, platform: "darwin" });
    const lines = [...renderScreen({ ...model, findings: [{ state: "attention", text: "4 lines need review", details: ["CLAUDE.md:14  Names a command the repo doesn't define.", "… and 1 more: mex rules"] }] }, mode), ...renderNext({ short: false }, mode)];
    for (const line of lines) expect(line.replace(/\x1b\[[0-9;]*m/gu, "").length).toBeLessThanOrEqual(columns);
  });
  it("suggests the person's own fact, not one setup already gave the agents", () => {
    const text = renderNext({ short: false }, screenMode({ stdoutTTY: false, columns: 120, env: {}, platform: "linux" })).join("\n");
    expect(text).toContain(NOTE_EXAMPLE);
    expect(NOTE_EXAMPLE).toBe('mex note "<something your agents keep getting wrong here, and why>"');
    expect(text).not.toMatch(/Run the tests with/u);
  });
});
