import React, { useEffect, useState } from "react";
import { stdin } from "node:process";
import { Box, Text, render, useInput, useStdout, type Instance } from "ink";
import type { AiTool } from "../types.js";
import type { SetupProgressStep } from "./headless.js";

const h = React.createElement;

export interface TerminalSetupView {
  projectName: string;
  mode: string;
  screen: "configure" | "progress" | "population" | "error" | "hub";
  tools: readonly { id: AiTool; name: string; selected: boolean; cliAvailable: boolean }[];
  initialTool?: AiTool | "continue";
  activeStep?: SetupProgressStep;
  completedSteps: readonly SetupProgressStep[];
  detail: string;
  startedAt: number;
  phaseStartedAt?: number;
  lastActivityAt?: number;
  progress?: { completed?: number; total?: number; unit?: string };
  error?: string;
  hubUrl?: string;
  populationAgent?: string | null;
  stopping?: boolean;
}

export type TerminalSetupAction =
  | { type: "toggle"; tool: AiTool }
  | { type: "start"; tool?: AiTool }
  | { type: "cancel" | "agent" | "prompt" | "check" | "exit" | "retry" };

type ActionHandler = (action: TerminalSetupAction) => void;
type Line = { text: string; color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean };
type Choice = { label: string; action: TerminalSetupAction };

const BANNER = [
  " __  __ _____ __  __",
  "|  \\/  | ____|\\ \\/ /",
  "| |\\/| |  _|   >  <",
  "|_|  |_|_____|/_/\\_\\",
];
const COLOR = {
  ink: "#ECE5D5",
  accent: "#F0B67F",
  cyan: "#74D2D0",
  border: "#496674",
  muted: "#95A6AC",
  complete: "#8CBAA3",
  selected: "#203440",
};
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PHASES: readonly [SetupProgressStep, string][] = [
  ["detect", "Project"],
  ["scaffold", "Scaffold"],
  ["tools", "AI tools"],
  ["skills", "Agent skills"],
  ["identity", "Identity"],
  ["scan", "Codebase scan"],
  ["graph", "Code graph"],
  ["population", "Project knowledge"],
  ["finalize", "Grounding + Wiki"],
];

// Text supplied by a subprocess or a project must not control the terminal.
function plain(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wrapped(value: string, width: number, limit: number): Line[] {
  if (limit < 1) return [];
  // Bound work as well as output when an agent supplies a very large detail.
  let remaining = plain(value.slice(0, 8_192));
  const result: Line[] = [];
  const span = Math.max(1, width - 1);
  while (remaining && result.length < limit) {
    if (remaining.length <= span) {
      result.push({ text: remaining });
      remaining = "";
    } else if (result.length === limit - 1) {
      result.push({ text: remaining.slice(0, Math.max(1, span - 3)) + "..." });
      remaining = "";
    } else {
      const space = remaining.lastIndexOf(" ", span);
      const end = space > span / 2 ? space : span;
      result.push({ text: remaining.slice(0, end) });
      remaining = remaining.slice(end).trimStart();
    }
  }
  return result;
}

function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000)) || 0;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function reportedCount(progress: TerminalSetupView["progress"]): string | undefined {
  if (!progress || !Number.isFinite(progress.completed) || progress.completed! < 0) return undefined;
  const completed = Math.floor(progress.completed!);
  const total = Number.isFinite(progress.total) && progress.total! >= completed ? Math.floor(progress.total!) : undefined;
  return `${completed.toLocaleString("en-US")}${total === undefined ? "" : ` / ${total.toLocaleString("en-US")}`}${progress.unit ? ` ${plain(progress.unit)}` : ""}`;
}

function divider(width: number, label: string, start = "├", end = "┤"): string {
  const text = plain(label).slice(0, Math.max(0, width - 6));
  return start + "─ " + text + " " + "─".repeat(Math.max(0, width - text.length - 5)) + end;
}

function choices(view: TerminalSetupView): Choice[] {
  if (view.screen === "population") {
    return [
      ...(view.populationAgent ? [{ label: `Open ${plain(view.populationAgent)}`, action: { type: "agent" as const } }] : []),
      { label: "Show setup prompt", action: { type: "prompt" } },
      { label: "Check populated files", action: { type: "check" } },
      { label: "Finish later", action: { type: "exit" } },
    ];
  }
  if (view.screen === "error") {
    return [
      { label: "Retry setup", action: { type: "retry" } },
      { label: "Exit setup", action: { type: "exit" } },
    ];
  }
  return [];
}

function title(view: TerminalSetupView): string {
  if (view.stopping) return "Stopping safely";
  switch (view.screen) {
    case "configure": return "Choose your AI tools";
    case "population": return "Add project knowledge";
    case "error": return "Setup needs attention";
    case "hub": return "Continue in your browser";
    case "progress": return "Preparing your project";
  }
}

function footer(view: TerminalSetupView, narrow: boolean): string {
  if (view.stopping) return "Waiting for the current operation to stop...";
  switch (view.screen) {
    case "configure": return narrow ? "Enter start Space multi ↑↓ ^C" : "Enter select/start  Space multi-select  Up/Down move  Ctrl+C exit";
    case "population": return narrow ? "Arrows / Enter / d details / ^C" : "Up/Down move  Enter choose  d details  Ctrl+C stop";
    case "error": return narrow ? "↑↓ Enter  d diagnostics  ^C" : "Up/Down move  Enter choose  d diagnostics  Ctrl+C stop";
    case "hub": return "d details  q / Ctrl+C stop Hub";
    case "progress": return "d details  Ctrl+C stop setup";
  }
}

function initialFocus(view: TerminalSetupView): number {
  if (view.screen !== "configure") return 0;
  if (view.initialTool === "continue") return view.tools.length;
  const index = view.tools.findIndex(tool => tool.id === view.initialTool);
  return Math.max(0, index);
}

function visibleChoices(groups: Line[][], focus: number, height: number): Line[] {
  const focusEnd = groups.slice(0, focus + 1).reduce((total, group) => total + group.length, 0);
  const start = Math.max(0, focusEnd - height);
  return groups.flat().slice(start, start + height);
}

function phaseLines(view: TerminalSetupView): Line[] {
  return PHASES.filter(([step]) => {
    if (view.mode === "agent-memory" && ["scan", "graph", "finalize"].includes(step)) return false;
    return step !== "skills" || view.tools.some(tool => tool.selected && (tool.id === "claude" || tool.id === "codex"));
  }).map(([step, label], index) => {
    const line = phaseLine(view, step, label);
    return { ...line, text: `${String(index + 1).padStart(2, "0")} ${line.text}` };
  });
}

function phaseLine(view: TerminalSetupView, step: SetupProgressStep, label: string): Line {
  if (view.completedSteps.includes(step)) return { text: `[done] ${label}`, color: COLOR.complete };
  if (view.screen === "hub") return { text: `[skip] ${label}`, color: COLOR.muted };
  if (view.activeStep === step) {
    const status = view.stopping ? "stop" : view.screen === "error" ? "fail" : view.screen === "population" ? "wait" : "now ";
    return { text: `[${status}] ${label}`, color: COLOR.accent, bold: true };
  }
  return { text: `[wait] ${label}`, color: COLOR.muted };
}

/** The renderer owns input only while mounted; native agents get the entire terminal. */
export function TerminalSetupHUD({ view, onAction }: { view: TerminalSetupView; onAction: ActionHandler }): React.ReactElement {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState(() => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 }));
  const [focus, setFocus] = useState(() => initialFocus(view));
  const [expanded, setExpanded] = useState(false);
  const [detailOffset, setDetailOffset] = useState(0);
  const [now, setNow] = useState(Date.now);
  const working = view.screen === "progress" && !view.stopping;
  const menu = choices(view);
  const count = view.screen === "configure" ? view.tools.length + 1 : menu.length;
  const selected = Math.min(focus, Math.max(0, count - 1));

  useEffect(() => {
    const resize = () => setDimensions({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);
  useEffect(() => { setFocus(initialFocus(view)); setExpanded(false); setDetailOffset(0); }, [view.screen, view.initialTool]);
  useEffect(() => { setDetailOffset(0); }, [view.detail, view.error, view.hubUrl]);
  useEffect(() => {
    setNow(Date.now());
    if (!working) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 120);
    return () => { clearInterval(timer); };
  }, [working]);

  useInput((input, key) => {
    if (view.stopping) return;
    if ((key.ctrl && (input === "c" || input === "d")) || (view.screen === "hub" && input.toLowerCase() === "q")) {
      onAction({ type: "cancel" });
      return;
    }
    if (input === "d" && view.screen !== "configure") { setExpanded(!expanded); return; }
    if (expanded) {
      if (key.escape) setExpanded(false);
      else if (key.upArrow) setDetailOffset(Math.max(0, visibleOffset - 1));
      else if (key.downArrow) setDetailOffset(Math.min(maxOffset, visibleOffset + 1));
      else if (key.pageUp) setDetailOffset(Math.max(0, visibleOffset - Math.max(1, bodyHeight - 1)));
      else if (key.pageDown) setDetailOffset(Math.min(maxOffset, visibleOffset + Math.max(1, bodyHeight - 1)));
      return;
    }
    if (key.upArrow && count) setFocus((selected + count - 1) % count);
    else if (key.downArrow && count) setFocus((selected + 1) % count);
    else if (view.screen === "configure" && input === " " && view.tools[selected]) {
      onAction({ type: "toggle", tool: view.tools[selected].id });
    } else if (key.return) {
      if (view.screen === "configure") onAction(view.tools[selected] ? { type: "start", tool: view.tools[selected].id } : { type: "start" });
      else if (menu[selected]) onAction(menu[selected].action);
    }
  });

  const height = Math.max(1, Math.min(23, dimensions.rows - 1));
  const padding = dimensions.columns >= 30 ? 1 : 0;
  const width = Math.max(1, dimensions.columns - padding * 2);
  const framed = width >= 24 && height >= 7;
  const fullBanner = view.screen === "configure" && width >= 60 && height >= 21;
  const header: Line[] = fullBanner
    ? BANNER.map((text, index) => ({ text: text + (index === 1 ? "    PROJECT MEMORY / SETUP" : index === 3 ? "    A place for project knowledge." : ""), color: COLOR.cyan, bold: true }))
    : [];
  if (height >= 11) header.push({ text: `${plain(view.projectName)}  /  ${plain(view.mode)}${width >= 60 ? `  /  TOTAL ${elapsed(view.startedAt, now)}` : ""}`, color: COLOR.muted });
  const bodyHeight = Math.max(0, height - header.length - (framed ? 4 : 2));
  const split = !expanded && width >= 74 && bodyHeight >= 9;
  const railWidth = view.screen === "configure" ? 46 : 31;
  const insideWidth = framed ? width - 4 : width;
  const contentWidth = split ? width - railWidth - 5 : insideWidth;
  const fullDetail = [view.error, view.detail, view.hubUrl].filter((value, index, values) => value && values.indexOf(value) === index).join("\n\n");
  const boundedDetail = fullDetail.length > 4_096
    ? fullDetail.slice(0, 3_040) + "\n[Middle of detail omitted]\n" + fullDetail.slice(-1_024)
    : fullDetail;
  const detailLines = wrapped(boundedDetail, insideWidth, 4_096);
  const maxOffset = Math.max(0, detailLines.length - bodyHeight);
  const visibleOffset = Math.min(detailOffset, maxOffset);
  let content: Line[] = [];
  let rail: Line[] = [];

  if (expanded) {
    content = detailLines.slice(visibleOffset, visibleOffset + bodyHeight);
  } else if (view.screen === "configure") {
    const selectedCount = view.tools.filter(tool => tool.selected).length;
    const continueFocused = selected === view.tools.length;
    const continueLabel = selectedCount ? "Continue with selected tools" : "Continue without an agent";
    const continueLines = wrapped(continueLabel, (split ? railWidth - 2 : insideWidth) - 2, 3).map((item, index) => ({
      text: `${continueFocused && index === 0 ? ">" : " "} ${item.text}`,
      color: continueFocused ? COLOR.accent : COLOR.cyan,
      backgroundColor: continueFocused ? COLOR.selected : undefined,
      bold: continueFocused,
    }));
    const toolLines = view.tools.map((tool, index) => ({
      text: `${index === selected ? ">" : " "} [${tool.selected ? "x" : " "}] ${plain(tool.name)}  ${tool.id === "claude" || tool.id === "codex" ? tool.cliAvailable ? "CLI ready" : "CLI not found" : "integration only"}`,
      color: index === selected ? COLOR.accent : COLOR.ink,
      backgroundColor: index === selected ? COLOR.selected : undefined,
      bold: index === selected,
    }));
    if (split) {
      rail = visibleChoices([...toolLines.map(item => [item, { text: "" }]), continueLines], selected, bodyHeight);
      const tool = view.tools[selected];
      const native = tool?.id === "claude" || tool?.id === "codex";
      content = [
        { text: continueFocused ? "CONTINUE" : native ? "NATIVE SETUP" : "INTEGRATION", color: COLOR.cyan, bold: true },
        { text: tool?.name ?? (selectedCount ? "Your selected tools" : "Manual setup"), color: COLOR.accent, bold: true },
        { text: "" },
        ...wrapped(continueFocused
          ? selectedCount
            ? "Start with only the checked tools. A selected Claude or Codex CLI can populate project knowledge."
            : "Start without selecting a tool. MEX will show a prompt to complete project knowledge manually."
          : native
            ? tool.cliAvailable
              ? `${tool.selected ? "Enter starts setup with this tool selected." : "Enter selects this tool and starts setup."} Its CLI is available.`
              : "Enter adds its instructions and starts setup. CLI not found; population may need the manual prompt."
            : "Enter adds this integration and starts setup. Populate project knowledge with a selected Claude or Codex CLI, or the manual prompt.", contentWidth, bodyHeight - 5),
        { text: "" },
        { text: `${selectedCount} selected`, color: COLOR.cyan },
      ];
    } else {
      // A compact Continue choice can occupy two lines; keep its full label
      // visible while moving through the same logical rows as a wider terminal.
      content = visibleChoices([...toolLines.map(item => [item]), continueLines], selected, bodyHeight);
      if (content.length < bodyHeight) content.push({ text: "" }, ...wrapped(view.detail || "Enter selects a tool and starts setup. Space optionally selects multiple tools.", contentWidth, bodyHeight - content.length - 1));
    }
  } else {
    if (split) rail = phaseLines(view);
    const menuBudget = Math.min(menu.length, Math.max(0, bodyHeight - 1));
    const detailBudget = Math.max(0, Math.min(6, bodyHeight - menuBudget - (menu.length ? 1 : 0)));
    if (working) {
      const activeLabel = PHASES.find(([step]) => step === view.activeStep)?.[1] ?? "Preparing setup";
      const phaseTime = elapsed(view.phaseStartedAt ?? view.startedAt, now);
      const quietTime = view.lastActivityAt === undefined ? undefined : elapsed(view.lastActivityAt, now);
      const counter = reportedCount(view.progress);
      content.push(
        { text: `${SPINNER[Math.floor(now / 120) % SPINNER.length]}  ${activeLabel}`, color: COLOR.accent, bold: true },
        { text: `Phase ${phaseTime}${!split && quietTime ? `  /  Quiet ${quietTime}` : ""}`, color: COLOR.ink },
      );
      if (counter && content.length < bodyHeight - 1) content.push({ text: counter, color: COLOR.cyan, bold: true });
      if (split) content.push({ text: "" }, { text: "LATEST EVENT", color: COLOR.cyan, bold: true });
      const remaining = Math.max(0, bodyHeight - content.length - (split ? 4 : 0));
      content.push(...wrapped(view.detail, contentWidth, Math.min(split ? 6 : 3, remaining)));
      if (split) content.push(
        { text: "" },
        { text: quietTime ? `No new events for ${quietTime}` : "No activity update yet", color: COLOR.muted },
        { text: "Waiting for the next reported event.", color: COLOR.muted },
      );
    } else if (!split && view.activeStep && bodyHeight >= menuBudget + 3) {
      const active = PHASES.find(([step]) => step === view.activeStep);
      if (active) content.push(phaseLine(view, ...active));
    }
    const detail = view.screen === "error" ? view.error || view.detail : view.detail;
    if (!working) content.push(...wrapped(detail, contentWidth, Math.max(0, detailBudget - content.length)).map(line => ({ ...line, color: view.screen === "error" ? COLOR.accent : COLOR.ink })));
    if (view.screen === "error" && view.detail && view.detail !== detail && bodyHeight - menuBudget - content.length >= 4) {
      content.push({ text: "" }, { text: "DIAGNOSTICS  [d] expand", color: COLOR.cyan, bold: true });
      content.push(...wrapped(view.detail, contentWidth, Math.min(5, bodyHeight - menuBudget - content.length - 1)).map(item => ({ ...item, color: COLOR.muted })));
    }
    if (view.screen === "hub" && view.hubUrl && content.length < bodyHeight) content.push(...wrapped(view.hubUrl, contentWidth, bodyHeight - content.length).map(item => ({ ...item, color: COLOR.cyan })));
    if (menu.length) {
      if (content.length < bodyHeight - menuBudget) content.push({ text: "" });
      const start = Math.max(0, selected - menuBudget + 1);
      content.push(...menu.slice(start, start + menuBudget).map((choice, offset) => ({
        text: `${start + offset === selected ? ">" : " "} ${choice.label}`,
        color: start + offset === selected ? COLOR.accent : COLOR.ink,
        backgroundColor: start + offset === selected ? COLOR.selected : undefined,
        bold: start + offset === selected,
      })));
    }
  }

  const line = (item: Line, key: string) => h(Text, { key, color: item.color ?? COLOR.ink, backgroundColor: item.backgroundColor, bold: item.bold, dimColor: item.dimColor, wrap: "truncate-end" }, item.text || " ");
  const edge = (text: string, key: string) => line({ text, color: COLOR.border }, key);
  const framedRow = (item: Line, key: string) => h(Box, { key, height: 1, flexShrink: 0 },
    ...(framed ? [edge("│ ", `${key}-left`)] : []),
    h(Box, { width: insideWidth, flexShrink: 0 }, line(item, `${key}-text`)),
    ...(framed ? [edge(" │", `${key}-right`)] : []),
  );
  const body = Array.from({ length: bodyHeight }, (_, index) => split
    ? h(Box, { key: `row-${index}`, height: 1, flexShrink: 0 },
      edge("│ ", `left-${index}`),
      h(Box, { width: railWidth - 2, flexShrink: 0 }, line(rail[index] || { text: "" }, `phase-${index}`)),
      edge(" │ ", `middle-${index}`),
      h(Box, { width: contentWidth, flexShrink: 0 }, line(content[index] || { text: "" }, `content-${index}`)),
      edge(" │", `right-${index}`),
    )
    : framedRow(content[index] || { text: "" }, `row-${index}`));
  const sectionTitle = expanded ? `Details ${visibleOffset + 1}-${Math.min(visibleOffset + bodyHeight, detailLines.length)} / ${detailLines.length}` : title(view);
  const section = split
    ? divider(railWidth + 2, view.screen === "configure" ? "Choose your AI tools" : "WORKFLOW", "├", "┬") + divider(width - railWidth - 1, view.screen === "configure" ? "FOCUS" : sectionTitle, "", "┤")
    : divider(width, sectionTitle);

  return h(Box, { flexDirection: "column", width: dimensions.columns, height, paddingX: padding, overflow: "hidden" },
    ...(height >= 2 ? [line({ text: framed ? divider(width, "MEX / SETUP", "╭", "╮") : "MEX / SETUP", color: COLOR.cyan, bold: true }, "brand")] : []),
    ...header.map((item, index) => framedRow(item, `header-${index}`)),
    ...(framed ? [line({ text: section, color: COLOR.border, bold: true }, "section")] : []),
    ...body,
    ...(framed ? [edge(split ? "╰" + "─".repeat(railWidth) + "┴" + "─".repeat(width - railWidth - 3) + "╯" : "╰" + "─".repeat(width - 2) + "╯", "bottom")] : []),
    line({ text: expanded ? (width < 55 ? "Arrows scroll  d/Esc back  ^C" : "Up/Down / PgUp/PgDn scroll  d / Esc back  Ctrl+C stop") : footer(view, width < 55), color: COLOR.muted }, "footer"),
  );
}

export function createTerminalSetupUI(initial: TerminalSetupView, onAction: ActionHandler): {
  update(view: TerminalSetupView): void;
  suspend(): Promise<void>;
  resume(view: TerminalSetupView): void;
  close(): Promise<void>;
} {
  let view = initial;
  let instance: Instance | undefined;
  let pending: Promise<void> | undefined;
  let suspended = false;
  let closed = false;
  const mount = () => {
    if (closed || suspended || instance) return;
    // Ink unrefs stdin on unmount. Keep the process alive until the fresh
    // renderer's input effect takes ownership again.
    if (stdin.isTTY) stdin.ref();
    instance = render(h(TerminalSetupHUD, { view, onAction }), {
      alternateScreen: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
  };
  const unmount = (): Promise<void> => {
    if (pending) return pending;
    const current = instance;
    instance = undefined;
    if (!current) return Promise.resolve();
    const teardown = (async () => {
      try {
        current.unmount();
        await current.waitUntilExit();
      } finally {
        current.cleanup();
      }
    })();
    pending = teardown.finally(() => { pending = undefined; });
    return pending;
  };
  mount();
  return {
    update(next) {
      view = next;
      instance?.rerender(h(TerminalSetupHUD, { view, onAction }));
    },
    async suspend() {
      suspended = true;
      await unmount();
      // Removing Ink's listener alone leaves Node reading ahead on the shared
      // descriptor, which can consume keystrokes intended for the native child.
      stdin.pause();
    },
    resume(next) {
      view = next;
      suspended = false;
      if (closed) return;
      if (instance) instance.rerender(h(TerminalSetupHUD, { view, onAction }));
      else if (pending) void pending.then(mount, () => {});
      else mount();
    },
    close() {
      closed = true;
      return unmount();
    },
  };
}
