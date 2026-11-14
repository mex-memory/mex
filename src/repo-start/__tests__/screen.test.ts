import { describe, expect, it } from "vitest";
import { formatSeconds, renderScreen, screenMode, wrap, type ScreenModel } from "../screen.js";
import { detectCaller, isAgentCaller } from "../caller.js";

const model: ScreenModel = {
  name: "novu", ms: 2412, costUsd: 0, hidden: true,
  findings: [
    { state: "ok", text: "Test and build commands for 12 packages (build @novu/dal first)" },
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
      "✓ Test and build commands for 12 packages (build @novu/dal first)",
      "✓ 21 notes from your Claude and Codex memory",
      "◌ The file index: in the background (`mex jobs`)",
      "Hooks: Claude Code and Codex, in your user settings.",
    ]);
    expect(lines.some(line => ANSI.test(line))).toBe(true);
  });

  it("renders plain ASCII lines with no colour when there is no terminal", () => {
    expect(renderScreen(model, screenMode({ stdoutTTY: false, env: {}, platform: "darwin" }))).toEqual([
      "MEX - novu - 2.4 s - $0 - nothing added to git",
      "ok Test and build commands for 12 packages (build @novu/dal first)",
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
