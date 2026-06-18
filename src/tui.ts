import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { stdin, stdout } from "node:process";
import type { DriftReport, MexConfig } from "./types.js";
import { findConfig } from "./config.js";
import { runDriftCheck } from "./drift/index.js";
import { checkHeartbeat, type HeartbeatResult } from "./heartbeat.js";
import { appendEvent, readEvents, type EventEntry, type EventKind } from "./events.js";
import { shouldShowInvite, recordInviteShown, INVITE_TEXT } from "./feedback/index.js";

const h = React.createElement;

type View = "dashboard" | "check" | "heartbeat" | "doctor" | "timeline" | "log-kind" | "log-message" | "log-file" | "log-done";
type LoadState = "loading" | "ready" | "error";

export interface DashboardData {
  report: DriftReport;
  heartbeat: HeartbeatResult;
  events: EventEntry[];
}

interface AppState {
  view: View;
  selected: number;
  loadState: LoadState;
  data: DashboardData | null;
  error: string | null;
  logKind: EventKind;
  logMessage: string;
  logFile: string;
  notice: string | null;
}

const MENU = [
  "Refresh dashboard",
  "Run check summary",
  "Run heartbeat",
  "Run doctor summary",
  "View timeline",
  "Log event",
  "Exit",
] as const;

const EVENT_KINDS: EventKind[] = ["note", "decision", "risk", "todo"];
const COLORS = {
  shell: "#5B8C5A",
  crab: "#E8845C",
  royal: "#1944F1",
};
const BAR_WIDTH = 18;
const ACTIVITY_DAYS = 7;

export function launchTui(): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.log("mex TUI requires an interactive terminal. Run `mex commands` to list CLI commands.");
    return;
  }
  try {
    const config = findConfig();
    render(h(TuiApp, { config }));
  } catch (err) {
    render(h(ErrorScreen, { message: (err as Error).message }));
  }
}

export async function loadDashboard(config: MexConfig): Promise<DashboardData> {
  const report = await runDriftCheck(config);
  const heartbeat = checkHeartbeat(config);
  const events = readEvents(config).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { report, heartbeat, events };
}

function TuiApp({ config }: { config: MexConfig }) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>({
    view: "dashboard",
    selected: 0,
    loadState: "loading",
    data: null,
    error: null,
    logKind: "note",
    logMessage: "",
    logFile: "",
    notice: null,
  });
  const [inviteVisible, setInviteVisible] = useState(false);

  const refresh = async (view: View = "dashboard", notice: string | null = null) => {
    setState((s) => ({ ...s, view, loadState: "loading", error: null, notice }));
    try {
      const data = await loadDashboard(config);
      setState((s) => ({ ...s, data, loadState: "ready", error: null, notice }));
    } catch (err) {
      setState((s) => ({ ...s, loadState: "error", error: (err as Error).message }));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Surface the feedback invite once per TUI session, respecting the same cap
  // and dismissal rules as the CLI nudge (recording the show in a effect, never
  // during render).
  useEffect(() => {
    if (shouldShowInvite()) {
      recordInviteShown();
      setInviteVisible(true);
    }
  }, []);

  useInput((input, key) => {
    if (input === "q" && state.view !== "log-message" && state.view !== "log-file") {
      exit();
      return;
    }
    if (key.escape) {
      setState((s) => ({ ...s, view: "dashboard", notice: null }));
      return;
    }

    if (state.view === "dashboard") {
      if (key.upArrow) {
        setState((s) => ({ ...s, selected: Math.max(0, s.selected - 1) }));
      } else if (key.downArrow) {
        setState((s) => ({ ...s, selected: Math.min(MENU.length - 1, s.selected + 1) }));
      } else if (input === "r") {
        void refresh("dashboard", "Dashboard refreshed");
      } else if (input === "l") {
        setState((s) => ({ ...s, view: "log-kind", notice: null }));
      } else if (key.return) {
        const action = MENU[state.selected];
        if (action === "Refresh dashboard") void refresh("dashboard", "Dashboard refreshed");
        if (action === "Run check summary") setState((s) => ({ ...s, view: "check", notice: null }));
        if (action === "Run heartbeat") setState((s) => ({ ...s, view: "heartbeat", notice: null }));
        if (action === "Run doctor summary") setState((s) => ({ ...s, view: "doctor", notice: null }));
        if (action === "View timeline") setState((s) => ({ ...s, view: "timeline", notice: null }));
        if (action === "Log event") setState((s) => ({ ...s, view: "log-kind", notice: null }));
        if (action === "Exit") exit();
      }
      return;
    }

    if (state.view === "log-kind") {
      const idx = EVENT_KINDS.indexOf(state.logKind);
      if (key.leftArrow || key.upArrow) {
        setState((s) => ({ ...s, logKind: EVENT_KINDS[(idx + EVENT_KINDS.length - 1) % EVENT_KINDS.length] }));
      } else if (key.rightArrow || key.downArrow) {
        setState((s) => ({ ...s, logKind: EVENT_KINDS[(idx + 1) % EVENT_KINDS.length] }));
      } else if (key.return) {
        setState((s) => ({ ...s, view: "log-message", logMessage: "", logFile: "" }));
      }
      return;
    }

    if (state.view === "log-message" || state.view === "log-file") {
      if (key.backspace || key.delete) {
        if (state.view === "log-message") {
          setState((s) => ({ ...s, logMessage: s.logMessage.slice(0, -1) }));
        } else {
          setState((s) => ({ ...s, logFile: s.logFile.slice(0, -1) }));
        }
      } else if (key.return) {
        if (state.view === "log-message") {
          if (state.logMessage.trim().length > 0) setState((s) => ({ ...s, view: "log-file" }));
        } else {
          try {
            appendEvent(config, state.logMessage.trim(), {
              kind: state.logKind,
              files: state.logFile.trim() ? [state.logFile.trim()] : [],
            });
            void refresh("log-done", `Logged ${state.logKind}`);
          } catch (err) {
            setState((s) => ({
              ...s,
              view: "dashboard",
              notice: `Log failed: ${(err as Error).message}`,
            }));
          }
        }
      } else if (input && !key.ctrl && !key.meta) {
        if (state.view === "log-message") {
          setState((s) => ({ ...s, logMessage: s.logMessage + input }));
        } else {
          setState((s) => ({ ...s, logFile: s.logFile + input }));
        }
      }
    }
  });

  if (state.loadState === "loading" && !state.data) return h(Frame, { config }, h(Text, null, "Loading mex dashboard..."));
  if (state.loadState === "error") return h(Frame, { config }, h(Text, { color: "red" }, state.error ?? "Unknown error"));
  if (!state.data) return h(Frame, { config }, h(Text, null, "No dashboard data."));

  return h(Frame, { config },
    h(Summary, { data: state.data, notice: state.notice }),
    h(Box, { marginTop: 1 },
      h(Menu, { selected: state.selected, active: state.view === "dashboard" }),
      h(Box, {
        borderStyle: "single",
        borderColor: COLORS.royal,
        flexDirection: "column",
        marginLeft: 2,
        minWidth: 46,
        paddingX: 1,
        paddingY: 0,
      },
        h(ViewPanel, { state, data: state.data }),
      ),
    ),
    h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, "↑/↓ choose · enter run · r refresh · l log · esc dashboard · q quit")),
    inviteVisible
      ? h(Box, { marginTop: 1 }, h(Text, { color: COLORS.crab }, `✨ ${INVITE_TEXT}`))
      : null,
  );
}

export function ErrorScreen({ message }: { message: string }) {
  return h(Box, { flexDirection: "column", paddingX: 1 },
    h(Text, { color: "red", bold: true }, "mex dashboard could not start"),
    h(Text, null, message),
    h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, "Run from a project root with a complete .mex scaffold, or run `mex setup`.")),
  );
}

function Frame({ config, children }: { config: MexConfig; children?: React.ReactNode }) {
  return h(Box, { flexDirection: "column", paddingX: 1 },
    h(BrandHeader, { scaffoldRoot: config.scaffoldRoot }),
    h(Box, { marginTop: 1, flexDirection: "column" }, children),
  );
}

export function Summary({ data, notice }: { data: DashboardData; notice: string | null }) {
  const errors = data.report.issues.filter((i) => i.severity === "error").length;
  const warnings = data.report.issues.filter((i) => i.severity === "warning").length;
  const scoreColor = data.report.score >= 80 ? "green" : data.report.score >= 50 ? "yellow" : "red";
  const heartbeatColor = data.heartbeat.ok ? "green" : "yellow";
  const heartbeatValue = data.heartbeat.ok ? 100 : Math.max(10, 100 - data.heartbeat.staleFiles.length * 25);
  const activity = eventActivityBars(data.events);
  return h(Box, { flexDirection: "column" },
    notice ? h(Text, { color: "green" }, notice) : null,
    h(StatusLine, {
      label: "Drift",
      value: `${data.report.score}/100`,
      bar: progressBar(data.report.score),
      color: scoreColor,
      detail: `${formatCount(errors, "error")} · ${formatCount(warnings, "warning")} · ${formatCount(data.report.filesChecked, "file")}`,
    }),
    h(StatusLine, {
      label: "Heartbeat",
      value: data.heartbeat.ok ? "OK" : "Attention",
      bar: progressBar(heartbeatValue),
      color: heartbeatColor,
      detail: `${formatCount(data.heartbeat.staleFiles.length, "stale file")}`,
    }),
    h(Text, null,
      h(Text, { color: COLORS.shell, bold: true }, "Events    "),
      h(Text, { bold: true }, String(data.events.length).padEnd(9)),
      h(Text, { color: COLORS.crab }, activity),
      `  last 7d · latest ${latestEvent(data.events)}`,
    ),
  );
}

function BrandHeader({ scaffoldRoot }: { scaffoldRoot: string }) {
  return h(Box, { flexDirection: "column" },
    h(SetupBanner, null),
    h(Text, null,
      h(Text, { bold: true }, "operational memory dashboard"),
      h(Text, { dimColor: true }, " · drift, heartbeat, and events"),
    ),
    h(Text, { dimColor: true }, `Scaffold: ${scaffoldRoot}`),
  );
}

export function SetupBanner() {
  return h(Box, { flexDirection: "column" },
    h(Text, { color: COLORS.royal }, "███╗   ███╗███████╗██╗  ██╗"),
    h(Text, { color: COLORS.royal }, "████╗ ████║██╔════╝╚██╗██╔╝"),
    h(Text, { color: COLORS.royal }, "██╔████╔██║█████╗   ╚███╔╝"),
    h(Text, { color: COLORS.royal }, "██║╚██╔╝██║██╔══╝   ██╔██╗"),
    h(Text, { color: COLORS.royal }, "██║ ╚═╝ ██║███████╗██╔╝ ██╗"),
    h(Text, { color: COLORS.royal }, "╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝"),
  );
}

function StatusLine({ label, value, bar, color, detail }: { label: string; value: string; bar: string; color: string; detail: string }) {
  return h(Text, null,
    h(Text, { color, bold: true }, label.padEnd(10)),
    h(Text, { bold: true }, value.padEnd(9)),
    h(Text, { color }, bar),
    `  ${detail}`,
  );
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function progressBar(value: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round((clamped / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function eventActivityBars(events: EventEntry[], days = ACTIVITY_DAYS, now = new Date()): string {
  const counts = Array.from({ length: days }, () => 0);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));

  for (const event of events) {
    const timestamp = new Date(event.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;
    const day = new Date(Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate()));
    const offset = Math.floor((day.getTime() - start.getTime()) / 86_400_000);
    if (offset >= 0 && offset < days) counts[offset] += 1;
  }

  const max = Math.max(...counts, 1);
  const levels = "▁▂▃▄▅▆▇█";
  return counts.map((count) => levels[Math.ceil((count / max) * (levels.length - 1))] ?? levels[0]).join("");
}

function Menu({ selected, active }: { selected: number; active: boolean }) {
  return h(Box, { flexDirection: "column", width: 26 },
    ...MENU.map((item, idx) => h(Text, { key: item, color: active && idx === selected ? "cyan" : undefined },
      `${active && idx === selected ? "›" : " "} ${item}`,
    )),
  );
}

function ViewPanel({ state, data }: { state: AppState; data: DashboardData }) {
  if (state.view === "check") return h(CheckPanel, { data });
  if (state.view === "heartbeat") return h(HeartbeatPanel, { data });
  if (state.view === "doctor") return h(DoctorPanel, { data });
  if (state.view === "timeline") return h(TimelinePanel, { data });
  if (state.view === "log-kind") return h(LogKindPanel, { kind: state.logKind });
  if (state.view === "log-message") return h(Text, null, `Message: ${state.logMessage || "_"}`);
  if (state.view === "log-file") return h(Box, { flexDirection: "column" },
    h(Text, null, `Related file (optional): ${state.logFile || "_"}`),
    h(Text, { dimColor: true }, "Press enter to save."),
  );
  if (state.view === "log-done") return h(TimelinePanel, { data });
  return h(Text, { dimColor: true }, "Choose an action.");
}

function CheckPanel({ data }: { data: DashboardData }) {
  const issues = data.report.issues.slice(0, 8);
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Check summary"),
    issues.length === 0
      ? h(Text, { color: "green" }, "No drift issues found. Scaffold is calm.")
      : issues.map((i, idx) => h(Text, { key: `${i.file}-${idx}` }, `${i.severity.toUpperCase()} ${i.code} ${i.file}: ${i.message}`)),
  );
}

export function HeartbeatPanel({ data }: { data: DashboardData }) {
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Heartbeat"),
    data.heartbeat.ok ? h(Text, { color: "green" }, "HEARTBEAT_OK · scaffold is fresh") : null,
    ...data.heartbeat.staleFiles.map((f) => h(Text, { key: f.file }, `Stale ${f.file} (${f.days} days)`)),
    data.heartbeat.memoryCleanupDue ? h(Text, null, "Memory cleanup is due.") : null,
    ...data.heartbeat.oldDailyMemoryFiles.map((f) => h(Text, { key: f }, `Old memory ${f}`)),
  );
}

function DoctorPanel({ data }: { data: DashboardData }) {
  const errors = data.report.issues.filter((i) => i.severity === "error").length;
  const warnings = data.report.issues.filter((i) => i.severity === "warning").length;
  const healthy = errors === 0 && data.heartbeat.ok;
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Doctor summary"),
    h(Text, { color: healthy ? "green" : "yellow" }, healthy ? "Scaffold looks healthy." : "Scaffold needs attention."),
    h(Text, null, `Drift ${data.report.score}/100 (${errors} errors, ${warnings} warnings)`),
    h(Text, null, data.heartbeat.ok ? "Heartbeat OK" : "Run `mex heartbeat` for details."),
    h(Text, null, `${data.events.length} logged events`),
  );
}

export function TimelinePanel({ data }: { data: DashboardData }) {
  const events = data.events.slice(0, 8);
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Timeline"),
    events.length === 0
      ? h(Text, { dimColor: true }, "No events yet. Use Log event when the why matters.")
      : events.map((e) => h(Text, { key: `${e.timestamp}-${e.message}` }, `${e.timestamp.slice(0, 10)} ${e.kind} ${e.message}`)),
  );
}

function LogKindPanel({ kind }: { kind: EventKind }) {
  const rendered = useMemo(() => EVENT_KINDS.map((k) => k === kind ? `[${k}]` : k).join("  "), [kind]);
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Log event"),
    h(Text, null, rendered),
    h(Text, { dimColor: true }, "Use left/right, then enter."),
  );
}

function latestEvent(events: EventEntry[]): string {
  if (!events.length) return "none";
  const e = events[0];
  return `${e.timestamp.slice(0, 10)} ${e.kind}`;
}
