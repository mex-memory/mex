import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { TerminalSetupHUD, type TerminalSetupView } from "../terminal-ui.js";

const h = React.createElement;
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const initial: TerminalSetupView = {
  projectName: "example-project", mode: "code-repo", screen: "configure",
  tools: [
    { id: "claude", name: "Claude Code", selected: true, cliAvailable: true },
    { id: "codex", name: "Codex", selected: false, cliAvailable: true },
    { id: "cursor", name: "Cursor", selected: false, cliAvailable: false },
    { id: "windsurf", name: "Windsurf", selected: false, cliAvailable: false },
    { id: "copilot", name: "Copilot", selected: false, cliAvailable: false },
    { id: "opencode", name: "OpenCode", selected: false, cliAvailable: true },
  ],
  completedSteps: [], detail: "Choose the tools you use.", startedAt: Date.now(),
};

async function show(changes: Partial<TerminalSetupView> = {}, columns = 80, rows = 24) {
  const onAction = vi.fn();
  const view = { ...initial, ...changes };
  const app = render(h(TerminalSetupHUD, { view, onAction }));
  Object.defineProperty(app.stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(app.stdout, "rows", { configurable: true, value: rows });
  await settle();
  app.stdout.emit("resize");
  await settle();
  return { ...app, view, onAction };
}

function expectFits(frame: string | undefined, columns: number, rows: number) {
  const lines = (frame ?? "").split("\n");
  expect(lines.length).toBeLessThanOrEqual(rows - 1);
  for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(columns);
}

function expectAlignedBorders(frame: string | undefined, columns: number) {
  const lines = (frame ?? "").split("\n").filter(line => line.includes("│"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const characters = Array.from(line);
    expect(characters.indexOf("│")).toBe(1);
    expect(characters.lastIndexOf("│")).toBe(columns - 2);
  }
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("terminal setup HUD", () => {
  it("presents the ASCII identity and tool selection within 80 by 24", async () => {
    const app = await show();
    expectFits(app.lastFrame(), 80, 24);
    expect(app.lastFrame()).toContain("88888b.d88b.   .d88b.  888  888");
    expect(app.lastFrame()).toContain("888 \"888 \"88b d8P  Y8b `Y8bd8P'");
    expect(app.lastFrame()).toContain("888  888  888 88888888   X88K");
    expect(app.lastFrame()).toContain("888  888  888 Y8b.     .d8\"\"8b.");
    expect(app.lastFrame()).toContain("888  888  888  \"Y8888  888  888");
    expect(app.lastFrame()).toContain("A place for project knowledge.");
    expect(app.lastFrame()).toContain("example-project  /  code-repo");
    expect(app.lastFrame()).toContain("> [x] Claude Code  CLI ready");
    expect(app.lastFrame()).toContain("[ ] Cursor");
    expect(app.lastFrame()).toContain("Enter select/start");
    expect(app.lastFrame()).toContain("Space multi-select");
    expect(app.lastFrame()).toContain("Continue with selected tools");
    expectAlignedBorders(app.lastFrame(), 80);
  });

  it("keeps the five-line banner and picker within 60 columns without clipping a side caption", async () => {
    const app = await show({}, 60, 24);
    expect(app.lastFrame()).toContain("88888b.d88b.   .d88b.  888  888");
    expect(app.lastFrame()).toContain("888  888  888  \"Y8888  888  888");
    expect(app.lastFrame()).not.toContain("A place for");
    expect(app.lastFrame()).toContain("Continue with selected tools");
    expect(app.lastFrame()).toContain("Enter select/start");
    expectFits(app.lastFrame(), 60, 24);
    expectAlignedBorders(app.lastFrame(), 60);
  });

  it("distinguishes a missing population CLI from tools that only receive an integration", async () => {
    const app = await show({ tools: initial.tools.map(tool => ({ ...tool, cliAvailable: tool.id === "opencode" })) });
    expect(app.lastFrame()).toContain("Claude Code  CLI not found");
    expect(app.lastFrame()).toContain("Codex  CLI not found");
    expect(app.lastFrame()).toContain("Cursor  integration only");
    expect(app.lastFrame()).toContain("OpenCode  integration only");
    expect(app.lastFrame()).not.toContain("CLI ready");
    expectFits(app.lastFrame(), 80, 24);
  });

  it("selects the highlighted unchecked tool and starts with one atomic Enter action", async () => {
    const app = await show({ tools: initial.tools.map(tool => ({ ...tool, selected: false })) });
    expect(app.lastFrame()).toContain("> [ ] Claude Code");
    expect(app.lastFrame()).toContain("Enter selects this tool");
    expect(app.lastFrame()).toContain("and starts setup.");
    app.stdin.write("\r");
    await settle();
    expect(app.onAction.mock.calls).toEqual([[{ type: "start", tool: "claude" }]]);
    expect(app.view.tools.every(tool => !tool.selected)).toBe(true);
  });

  it("starts with a checked tool without toggling it off", async () => {
    const app = await show();
    app.stdin.write("\r");
    await settle();
    expect(app.onAction.mock.calls).toEqual([[{ type: "start", tool: "claude" }]]);
    expect(app.view.tools[0].selected).toBe(true);
  });

  it("starts with the moved-to unchecked tool without requiring Space", async () => {
    const app = await show({ tools: initial.tools.map(tool => ({ ...tool, selected: false })) });
    app.stdin.write("\u001b[B");
    await settle();
    expect(app.lastFrame()).toContain("> [ ] Codex");
    app.stdin.write("\r");
    await settle();
    expect(app.onAction.mock.calls).toEqual([[{ type: "start", tool: "codex" }]]);
  });

  it("uses the requested initial tool focus without reordering choices", async () => {
    const app = await show({ initialTool: "codex" });
    expect(app.lastFrame()).toContain("> [ ] Codex");
    expect(app.lastFrame()!.indexOf("Claude Code")).toBeLessThan(app.lastFrame()!.indexOf("> [ ] Codex"));
    app.stdin.write("\r");
    await settle();
    expect(app.onAction.mock.calls).toEqual([[{ type: "start", tool: "codex" }]]);
  });

  it.each([true, false])("continues with the current selection without adding a tool (selected: %s)", async hasSelectedTool => {
    const app = await show({ initialTool: "continue", tools: initial.tools.map(tool => ({ ...tool, selected: hasSelectedTool && tool.id === "claude" })) });
    expect(app.lastFrame()).toContain(hasSelectedTool ? "> Continue with selected tools" : "> Continue without an agent");
    app.stdin.write(" ");
    await settle();
    expect(app.onAction).not.toHaveBeenCalled();
    app.stdin.write("\r");
    await settle();
    expect(app.onAction.mock.calls).toEqual([[{ type: "start" }]]);
    expect(app.view.tools.filter(tool => tool.selected).map(tool => tool.id)).toEqual(hasSelectedTool ? ["claude"] : []);
    expectFits(app.lastFrame(), 80, 24);
  });

  it("moves tool focus, optionally toggles multiple tools with Space, and starts on Enter", async () => {
    const app = await show();
    app.stdin.write("\u001b[B");
    await settle();
    app.stdin.write(" ");
    await settle();
    expect(app.onAction).toHaveBeenLastCalledWith({ type: "toggle", tool: "codex" });
    expect(app.lastFrame()).toContain("> [ ] Codex");
    app.rerender(h(TerminalSetupHUD, {
      view: { ...app.view, tools: app.view.tools.map(tool => ({ ...tool, selected: tool.id === "codex" || tool.selected })) },
      onAction: app.onAction,
    }));
    await settle();
    expect(app.lastFrame()).toContain("> [x] Codex");
    app.stdin.write("\r");
    await settle();
    expect(app.onAction.mock.calls).toEqual([[{ type: "toggle", tool: "codex" }], [{ type: "start", tool: "codex" }]]);
  });

  it("keeps a focused tool visible when a small terminal needs a scrolling list", async () => {
    const app = await show({}, 32, 9);
    app.stdin.write("\u001b[A");
    await settle();
    app.stdin.write("\u001b[A");
    await settle();
    expectFits(app.lastFrame(), 32, 9);
    expect(app.lastFrame()).toContain("> [ ] OpenCode");
    expect(app.lastFrame()).toContain("Enter");
    app.stdin.write(" ");
    await settle();
    expect(app.onAction).toHaveBeenLastCalledWith({ type: "toggle", tool: "opencode" });
  });

  it.each([true, false])("keeps the focused Continue choice usable after resizing to 32 by 9 (selected: %s)", async hasSelectedTool => {
    const app = await show({ tools: initial.tools.map(tool => ({ ...tool, selected: hasSelectedTool && tool.id === "claude" })) });
    app.stdin.write("\u001b[A");
    await settle();
    expect(app.lastFrame()).toContain(hasSelectedTool ? "> Continue with selected tools" : "> Continue without an agent");
    Object.defineProperties(app.stdout, { columns: { configurable: true, value: 32 }, rows: { configurable: true, value: 9 } });
    app.stdout.emit("resize");
    await settle();
    const text = app.lastFrame()?.replace(/│/g, " ").replace(/\s+/g, " ");
    expect(text).toContain(hasSelectedTool ? "> Continue with selected tools" : "> Continue without an agent");
    expect(app.lastFrame()).toContain("Enter start Space multi");
    expectFits(app.lastFrame(), 32, 9);
    expectAlignedBorders(app.lastFrame(), 32);
    app.stdin.write("\r");
    await settle();
    expect(app.onAction.mock.calls).toEqual([[{ type: "start" }]]);
  });

  it("shows only reported completion and the active phase, without synthetic progress", async () => {
    const app = await show({ screen: "progress", completedSteps: ["detect", "scaffold"], activeStep: "graph", detail: "Indexing local source files." });
    expectFits(app.lastFrame(), 80, 24);
    expect(app.lastFrame()).toContain("[done] Project");
    expect(app.lastFrame()).toContain("[done] Scaffold");
    expect(app.lastFrame()).toContain("[now ] Code graph");
    expect(app.lastFrame()).toContain("[wait] Project knowledge");
    expect(app.lastFrame()).not.toContain("%");
    expect(app.lastFrame()).toContain("01 [done] Project");
    expect(app.lastFrame()).toContain("WORKFLOW");
    expect(app.lastFrame()).toContain("LATEST EVENT");
    expect(app.lastFrame()).toContain("╭─ MEX / SETUP");
  });

  it("animates pending work and advances phase and quiet clocks without inventing progress", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(100_000);
    const app = await show({ screen: "progress", activeStep: "graph", startedAt: 50_000, phaseStartedAt: 90_000, lastActivityAt: 95_000, detail: "Parsing source files" });
    expect(app.lastFrame()).toContain("Phase 10s");
    expect(app.lastFrame()).toContain("No new events for 5s");
    expectAlignedBorders(app.lastFrame(), 80);
    const first = app.lastFrame();
    vi.advanceTimersByTime(120);
    await settle();
    expect(app.lastFrame()).not.toBe(first);
    expect(app.lastFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]  Code graph/);
    expectAlignedBorders(app.lastFrame(), 80);
    vi.advanceTimersByTime(5_880);
    await settle();
    expect(app.lastFrame()).toContain("Phase 16s");
    expect(app.lastFrame()).toContain("No new events for 11s");
    expect(app.lastFrame()).toContain("[now ] Code graph");
    expect(app.lastFrame()).not.toContain("[done] Code graph");
    expect(app.lastFrame()).not.toContain("%");
    app.rerender(h(TerminalSetupHUD, { view: { ...app.view, lastActivityAt: 106_000, detail: "Writing graph candidate" }, onAction: app.onAction }));
    await settle();
    expect(app.lastFrame()).toContain("Phase 16s");
    expect(app.lastFrame()).toContain("No new events for 0s");
    app.unmount();
    await settle();
    const frames = app.frames.length;
    vi.advanceTimersByTime(2_000);
    await settle();
    expect(app.frames).toHaveLength(frames);
  });

  it("does not animate configuration, manual choices, errors, Hub, or stopping work", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(100_000);
    const app = await show({ startedAt: 50_000 });
    for (const screen of ["configure", "population", "error", "hub", "progress"] as const) {
      app.rerender(h(TerminalSetupHUD, { view: { ...app.view, screen, stopping: screen === "progress" }, onAction: app.onAction }));
      await settle();
      const frame = app.lastFrame();
      vi.advanceTimersByTime(1_500);
      await settle();
      expect(app.lastFrame()).toBe(frame);
      expect(app.lastFrame()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    }
  });

  it("shows only supplied finite counts and removes stale counts on the next view", async () => {
    const app = await show({ screen: "progress", activeStep: "graph", detail: "Parsing source files", progress: { completed: 12, total: 200, unit: "files parsed" } });
    expect(app.lastFrame()).toContain("12 / 200 files parsed");
    expect(app.lastFrame()).not.toContain("%");
    app.rerender(h(TerminalSetupHUD, { view: { ...app.view, progress: { completed: Infinity, total: 200, unit: "files parsed" } }, onAction: app.onAction }));
    await settle();
    expect(app.lastFrame()).not.toContain("files parsed");
    app.rerender(h(TerminalSetupHUD, { view: { ...app.view, progress: undefined }, onAction: app.onAction }));
    await settle();
    expect(app.lastFrame()).not.toContain("files parsed");
  });

  it("prioritizes the real count and phase clocks in a 32 by 12 terminal", async () => {
    const app = await show({ screen: "progress", activeStep: "graph", phaseStartedAt: Date.now() - 18_000, lastActivityAt: Date.now() - 3_000, detail: "Parsing source files with the TypeScript compiler.", progress: { completed: 324, total: 1000, unit: "files parsed" } }, 32, 12);
    expect(app.lastFrame()).toContain("324 / 1,000 files parsed");
    expect(app.lastFrame()).toContain("Phase 18s");
    expect(app.lastFrame()).toContain("Quiet 3s");
    expectFits(app.lastFrame(), 32, 12);
    expectAlignedBorders(app.lastFrame(), 32);
  });

  it("omits phases that agent-memory mode and no selected integrations do not run", async () => {
    const app = await show({ screen: "progress", mode: "agent-memory", tools: [], activeStep: "population" });
    expect(app.lastFrame()).not.toContain("Code graph");
    expect(app.lastFrame()).not.toContain("Codebase scan");
    expect(app.lastFrame()).not.toContain("Grounding + Wiki");
    expect(app.lastFrame()).not.toContain("Agent skills");
    expect(app.lastFrame()).toContain("[now ] Project knowledge");
  });

  it("does not promise agent skills for an editor-only integration", async () => {
    const app = await show({ screen: "progress", tools: initial.tools.map(tool => ({ ...tool, selected: tool.id === "cursor" })) });
    expect(app.lastFrame()).not.toContain("Agent skills");
  });

  it.each([
    ["population", "[wait] Project knowledge"],
    ["error", "[fail] Project knowledge"],
    ["hub", "[skip] Project knowledge"],
  ] as const)("keeps %s status distinct from active work", async (screen, status) => {
    const app = await show({ screen, activeStep: "population", completedSteps: ["scaffold"] });
    expect(app.lastFrame()).toContain(status);
    expect(app.lastFrame()).toContain("[done] Scaffold");
    expect(app.lastFrame()).not.toContain("88888b.d88b.");
  });

  it.each(["configure", "progress", "population", "error", "hub"] as const)("cancels %s on Ctrl+C and raw-mode EOF", async screen => {
    const app = await show({ screen });
    app.stdin.write("\u0003");
    await settle();
    app.stdin.write("\u0004");
    await settle();
    expect(app.onAction.mock.calls).toEqual([[{ type: "cancel" }], [{ type: "cancel" }]]);
  });

  it("offers native agent handoff, prompt, check, and explicit pause separately", async () => {
    const app = await show({ screen: "population", populationAgent: "Codex" });
    app.stdin.write("\r");
    await settle();
    expect(app.onAction).toHaveBeenLastCalledWith({ type: "agent" });
    for (const type of ["prompt", "check", "exit"]) {
      app.stdin.write("\u001b[B");
      await settle();
      app.stdin.write("\r");
      await settle();
      expect(app.onAction).toHaveBeenLastCalledWith({ type });
    }
  });

  it("does not offer an unavailable agent and resets focus for an error screen", async () => {
    const app = await show({ screen: "population", populationAgent: null });
    expect(app.lastFrame()).not.toContain("Open Codex");
    app.stdin.write("\r");
    await settle();
    expect(app.onAction).toHaveBeenLastCalledWith({ type: "prompt" });
    app.stdin.write("\u001b[B");
    await settle();
    app.rerender(h(TerminalSetupHUD, { view: { ...app.view, screen: "error", error: "Resolve the conflict, then retry." }, onAction: app.onAction }));
    await settle();
    app.stdin.write("\r");
    await settle();
    expect(app.onAction).toHaveBeenLastCalledWith({ type: "retry" });
    app.stdin.write("\u001b[B");
    await settle();
    app.stdin.write("\r");
    await settle();
    expect(app.onAction).toHaveBeenLastCalledWith({ type: "exit" });
  });

  it("lets users scroll all bounded remediation without invoking menu actions", async () => {
    const error = "Inspect retained files before retrying. ".repeat(35) + "FINAL REMEDIATION: reconcile the backup first.";
    const app = await show({ screen: "error", error }, 40, 12);
    expectFits(app.lastFrame(), 40, 12);
    app.stdin.write("d");
    await settle();
    expect(app.lastFrame()).toContain("Details 1-");
    for (let index = 0; index < 20; index++) { app.stdin.write("\u001b[6~"); await settle(); }
    expect(app.lastFrame()?.replace(/│/g, "").replace(/\s+/g, " ")).toContain("backup first.");
    expectFits(app.lastFrame(), 40, 12);
    app.stdin.write("\r");
    await settle();
    expect(app.onAction).not.toHaveBeenCalled();
    app.stdin.write("\u001b");
    await settle();
    expect(app.lastFrame()).toContain("Retry setup");
  });

  it("wraps the Hub link and retains the complete URL in scrollable details", async () => {
    const hubUrl = "http://127.0.0.1:43123/setup#token=" + "abcdef0123456789".repeat(4);
    const app = await show({ screen: "hub", detail: "Review setup in the browser.", hubUrl });
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("http://127.0.0.1:43123/");
    expect(frame).not.toContain("...");
    expectFits(frame, 80, 24);
    app.stdin.write("q");
    await settle();
    expect(app.onAction).toHaveBeenLastCalledWith({ type: "cancel" });
  });

  it("keeps the end of a long Hub URL accessible after shrinking the terminal", async () => {
    const hubUrl = "http://127.0.0.1:43123/setup#token=" + "abcdef0123456789".repeat(6) + "TOKENEND";
    const app = await show({ screen: "hub", detail: "Review setup in your browser.", hubUrl }, 32, 10);
    expectFits(app.lastFrame(), 32, 10);
    app.stdin.write("d");
    await settle();
    for (let index = 0; index < 4; index++) { app.stdin.write("\u001b[6~"); await settle(); }
    expect(app.lastFrame()).toContain("TOKENEND");
    expectFits(app.lastFrame(), 32, 10);
  });

  it("bounds very large unsafe details and suppresses input while stopping", async () => {
    const app = await show({ screen: "progress", detail: "\u001b[2J\u001b[31mBAD\n".repeat(10_000), stopping: true }, 40, 12);
    expectFits(app.lastFrame(), 40, 12);
    expect(app.lastFrame()).not.toContain("\u001b");
    expect(app.lastFrame()).toContain("Stopping safely");
    app.stdin.write("\u0003");
    await settle();
    expect(app.onAction).not.toHaveBeenCalled();
  });

  it("exposes a bounded error diagnostic preview and a discoverable expansion key", async () => {
    const app = await show({ screen: "error", activeStep: "graph", error: "The graph worker exceeded its Node.js heap limit. Increase its memory allowance and retry setup.", detail: "Diagnostics: Worker stopped with SIGABRT while parsing 865 / 924 files. V8 heap allocation failed." });
    expect(app.lastFrame()).toContain("DIAGNOSTICS  [d] expand");
    expect(app.lastFrame()).toContain("SIGABRT");
    expect(app.lastFrame()).toContain("865 / 924");
    expect(app.lastFrame()).toContain("d diagnostics");
    expect(app.lastFrame()).toContain("> Retry setup");
    expectFits(app.lastFrame(), 80, 24);
  });
});
